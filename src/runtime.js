function workerBootstrap(config, createNetworkTools, createHlsTools, createWorkerEngine, originalURL, initialContext, workerId) {
    const engine = createWorkerEngine(self, config, createNetworkTools, createHlsTools, initialContext, workerId);
    engine.start();
    try {
        // Classic workers only. importScripts preserves the existing TwitchNoSub wrapper.
        importScripts(originalURL);
        engine.refreshFetch();
        self.postMessage({ namespace: 'vaft-matteo:1', workerId, epoch: initialContext.epoch, type: 'ready' });
    } catch (failure) {
        self.postMessage({ namespace: 'vaft-matteo:1', workerId, epoch: initialContext.epoch, type: 'startup-error' });
        throw failure;
    }
}

function createVaftRuntime(env, config, createNetworkTools, createHlsTools, createPlayerController, createWorkerEngine, bootstrap) {
    const window = env.window;
    const net = createNetworkTools(window);
    const protocol = 'vaft-matteo:1';
    const originalFetch = window.fetch;
    const originalWorker = window.Worker;
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker');
    const workers = new Map();
    const credentials = new Map();
    const eventCounts = new Map();
    let serial = 0;
    let controller;
    let context = { kind: 'unknown', id: null, epoch: 0 };
    let stopped = false;
    let suspended = false;
    let exposedWorker;
    let lastLog = 0;
    let gqlSequence = 0;
    const allowedEvents = new Set(['module-worker-unsupported', 'worker-startup-error', 'worker-startup-timeout',
        'worker-terminated', 'vod-ad-observed', 'token-error', 'worker-hook-unavailable', 'fetch-hook-unavailable',
        'player-context', 'player-ambiguous', 'player-error', 'player-reload', 'player-recovery', 'vod-waiting', 'vod-skip']);

    function diagnostic(event) {
        const code = typeof event === 'string' ? event : event?.code;
        if (!allowedEvents.has(code)) return;
        eventCounts.set(code, (eventCounts.get(code) || 0) + 1);
        const now = Date.now();
        if (config.debug && now - lastLog >= 2000) {
            lastLog = now;
            // Only allowlisted codes and numeric counters, never request/error objects.
            window.console.info('[VAFT]', Object.fromEntries(eventCounts));
        }
    }

    function post(record, type, data = {}) {
        if (!workers.has(record.worker) || stopped) return;
        record.worker.postMessage({ namespace: protocol, workerId: record.id, epoch: context.epoch, type, ...data });
    }

    function cancelRequests(record) {
        for (const request of record.requests.values()) request.abort();
        record.requests.clear();
    }

    function revoke(record) {
        if (!record.blobURL) return;
        window.URL.revokeObjectURL(record.blobURL);
        record.blobURL = null;
        if (record.sourceURL) window.URL.revokeObjectURL(record.sourceURL);
        record.sourceURL = null;
        window.clearTimeout(record.timer);
    }

    function detach(record) {
        cancelRequests(record);
        revoke(record);
        record.worker.removeEventListener('message', record.onMessage);
        record.worker.removeEventListener('error', record.onError);
        workers.delete(record.worker);
    }

    function onContextChange(next) {
        if (stopped) return;
        context = { ...next };
        diagnostic('player-context');
        for (const record of workers.values()) {
            cancelRequests(record);
            post(record, 'context', { context });
        }
    }

    function validTokenRequest(message) {
        return !suspended && context.kind === 'live' && Number.isSafeInteger(message.id) && message.id > 0 &&
            typeof message.channel === 'string' && /^[a-z0-9_]{1,64}$/i.test(message.channel) &&
            message.channel.toLowerCase() === context.id?.toLowerCase() &&
            config.backupPlayerTypes.includes(message.playerType);
    }

    async function relayToken(record, message) {
        // The Worker never supplies a URL, headers or arbitrary GraphQL body.
        if (!validTokenRequest(message) || record.requests.has(message.id) || record.requests.size >= 3) return;
        const request = new window.AbortController();
        record.requests.set(message.id, request);
        const epoch = context.epoch;
        const headers = new window.Headers(Object.fromEntries(credentials));
        if (!headers.has('Client-ID')) headers.set('Client-ID', 'kimne78kx3ncx6brgo4mv6wki5h1ko');
        headers.set('Content-Type', 'text/plain;charset=UTF-8');
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: { isLive: true, login: message.channel, isVod: false, vodID: '',
                playerType: message.playerType, platform: message.playerType === 'autoplay' ? 'android' : 'web' },
            extensions: { persistedQuery: { version: 1,
                sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9' } }
        };
        try {
            const { response, text } = await net.requestText(originalFetch.bind(window), 'https://gql.twitch.tv/gql',
                { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal }, config.requestTimeoutMs);
            if (!response.ok) throw new Error('token-error');
            const token = JSON.parse(text)?.data?.streamPlaybackAccessToken;
            if (typeof token?.value !== 'string' || typeof token.signature !== 'string') throw new Error('token-error');
            if (epoch === context.epoch && !request.signal.aborted) post(record, 'token-result', { id: message.id, value: token.value, signature: token.signature });
        } catch (failure) {
            diagnostic('token-error');
            if (epoch === context.epoch && !request.signal.aborted) post(record, 'token-result', {
                id: message.id, error: failure?.name === 'TimeoutError' ? 'TimeoutError' : 'NetworkError' });
        } finally {
            if (record.requests.get(message.id) === request) record.requests.delete(message.id);
        }
    }

    function attach(worker, id, blobURL, sourceURL) {
        const record = { worker, id, blobURL, sourceURL, requests: new Map(), timer: null, onMessage: null, onError: null };
        record.onMessage = event => {
            const message = event.data;
            if (message?.namespace !== protocol || message.workerId !== id) return;
            // Startup acknowledgements are independent from a SPA epoch change.
            if (message.type === 'ready') { revoke(record); post(record, 'context', { context }); return; }
            if (message.type === 'startup-error') {
                diagnostic('worker-startup-error');
                controller.setStatus({ state: 'error', hasAds: false });
                detach(record);
                return;
            }
            if (message.epoch !== context.epoch || suspended || stopped) return;
            if (message.type === 'token') void relayToken(record, message);
            else if (message.type === 'cancel-token' && Number.isSafeInteger(message.id)) record.requests.get(message.id)?.abort();
            else if (message.type === 'status' && ['playing', 'searching', 'waiting-ad', 'resuming', 'error'].includes(message.state)) {
                controller.setStatus({ state: message.state, hasAds: message.hasAds === true });
            } else if (message.type === 'reload' && context.kind === 'live') controller.task({ reload: true });
            else if (message.type === 'vod-ranges' && Array.isArray(message.ranges) && message.ranges.length <= 1000) {
                controller.setVodRanges({ id: message.id, epoch: message.epoch, ranges: message.ranges, timelineReliable: message.timelineReliable === true });
            } else if (message.type === 'diagnostic') diagnostic(message.code);
        };
        record.onError = () => {
            diagnostic('worker-startup-error');
            controller.setStatus({ state: 'error', hasAds: false });
            post(record, 'shutdown');
            detach(record);
        };
        workers.set(worker, record);
        worker.addEventListener('message', record.onMessage);
        worker.addEventListener('error', record.onError);
        // Own the registry entry, not the worker's lifetime. Do not terminate third-party workers.
        const terminate = worker.terminate;
        worker.terminate = function(...args) {
            detach(record);
            diagnostic('worker-terminated');
            return Reflect.apply(terminate, this, args);
        };
        record.timer = window.setTimeout(() => {
            diagnostic('worker-startup-timeout');
            controller.setStatus({ state: 'error', hasAds: false });
            post(record, 'shutdown');
            // Release the bootstrap resource on explicit startup failure, too.
            detach(record);
        }, config.requestTimeoutMs);
    }

    function isTwitchWorker(input) {
        const url = net.readFetchURL(input, window.location.href);
        if (!url) return false;
        try {
            const origin = new window.URL(url.origin);
            return origin.protocol === 'https:' && (origin.hostname === 'twitch.tv' || origin.hostname.endsWith('.twitch.tv'));
        } catch { return false; }
    }

    function constructWorker(target, args, newTarget) {
        const [input, options] = args;
        if (stopped || !isTwitchWorker(input)) return Reflect.construct(target, args, newTarget);
        if (options?.type === 'module') {
            diagnostic('module-worker-unsupported');
            controller.setStatus({ state: 'error', hasAds: false });
            return Reflect.construct(target, args, newTarget);
        }
        const id = ++serial;
        const url = net.readFetchURL(input, window.location.href).href;
        let sourceURL = null;
        if (url.startsWith('blob:')) {
            // The caller may revoke its Blob immediately after new Worker returns.
            // Snapshot its small bootstrap now; we own the alias until the ready handshake.
            try {
                const request = new window.XMLHttpRequest();
                request.open('GET', url, false);
                request.overrideMimeType('text/javascript');
                request.send();
                if (request.status !== 0 && request.status !== 200) throw new Error('VAFT worker source unavailable');
                sourceURL = window.URL.createObjectURL(new window.Blob([request.responseText], { type: 'text/javascript' }));
            } catch {
                diagnostic('worker-startup-error');
                controller.setStatus({ state: 'error', hasAds: false });
                return Reflect.construct(target, args, newTarget);
            }
        }
        const source = `(${bootstrap.toString()})(${JSON.stringify(config)},${createNetworkTools.toString()},${createHlsTools.toString()},${createWorkerEngine.toString()},${JSON.stringify(sourceURL || url)},${JSON.stringify(context)},${id});`;
        const blobURL = window.URL.createObjectURL(new window.Blob([source], { type: 'text/javascript' }));
        try {
            const worker = Reflect.construct(target, [blobURL, ...args.slice(1)], newTarget);
            attach(worker, id, blobURL, sourceURL);
            return worker;
        } catch (failure) {
            window.URL.revokeObjectURL(blobURL);
            if (sourceURL) window.URL.revokeObjectURL(sourceURL);
            diagnostic('worker-startup-error');
            throw failure;
        }
    }

    async function wrappedFetch(input, init) {
        const sequence = net.readFetchURL(input, window.location.href)?.href === 'https://gql.twitch.tv/gql' ? ++gqlSequence : null;
        const result = await net.rewritePlaybackRequest(input, init, config.forcePlayerType, window.location.href);
        if (result.headers && sequence === gqlSequence && !stopped) {
            // Replace session headers atomically; never retain Authorization after logout.
            credentials.clear();
            for (const name of ['Client-ID', 'X-Device-Id', 'Device-ID', 'Authorization', 'Client-Integrity', 'Client-Version', 'Client-Session-Id']) {
                const value = result.headers.get(name);
                if (value) credentials.set(name, value);
            }
        }
        return Reflect.apply(originalFetch, window, [result.input, result.init]);
    }

    function onPageHide(event) {
        suspended = true;
        for (const record of workers.values()) {
            cancelRequests(record);
            post(record, 'context', { context });
        }
        if (!event.persisted) stop();
    }

    function onPageShow(event) {
        if (!event.persisted || stopped) return;
        suspended = false;
        controller.start();
        onContextChange(controller.getContext());
    }

    function start() {
        controller = createPlayerController(env, config, { onContextChange, onDiagnostic: diagnostic });
        controller.start();
        context = controller.getContext();
        try { window.fetch = wrappedFetch; } catch { diagnostic('fetch-hook-unavailable'); }
        exposedWorker = new Proxy(originalWorker, { construct: constructWorker });
        try {
            // Leave future wrappers in their original order. No toString filtering or prototype surgery.
            Object.defineProperty(window, 'Worker', { configurable: true, enumerable: true,
                get: () => exposedWorker, set: value => {
                    // Normalize URL objects for older TwitchNoSub constructors using replaceAll.
                    exposedWorker = typeof value !== 'function' ? value : new Proxy(value, {
                        construct(target, args, newTarget) {
                            const forwarded = args.slice();
                            if (forwarded[0] instanceof window.URL) forwarded[0] = forwarded[0].href;
                            return Reflect.construct(target, forwarded, newTarget);
                        }
                    });
                } });
        } catch { diagnostic('worker-hook-unavailable'); }
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        if (config.debug) {
            Object.defineProperty(window, '__VAFT_MATTEO_DEBUG__', { configurable: true, value: {
                snapshot: getDiagnostics,
                simulateAds(enabled = true) { for (const record of workers.values()) post(record, 'simulate-ads', { enabled: enabled === true }); }
            } });
        }
    }

    function stop() {
        if (stopped) return;
        for (const record of workers.values()) post(record, 'shutdown');
        stopped = true;
        controller?.stop();
        for (const record of workers.values()) detach(record);
        credentials.clear();
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
        // Do not remove a wrapper subsequently installed by TwitchNoSub or another script.
        const descriptor = Object.getOwnPropertyDescriptor(window, 'Worker');
        if (descriptor?.get && exposedWorker && exposedWorker !== originalWorker) {
            Object.defineProperty(window, 'Worker', { configurable: true, enumerable: true, writable: true, value: exposedWorker });
        } else if (originalDescriptor) Object.defineProperty(window, 'Worker', originalDescriptor);
        if (config.debug) delete window.__VAFT_MATTEO_DEBUG__;
    }

    function getDiagnostics() {
        return { version: config.version, context: { ...context }, workers: workers.size,
            requests: Array.from(workers.values()).reduce((sum, record) => sum + record.requests.size, 0),
            blobURLs: Array.from(workers.values()).reduce((sum, record) => sum + Number(!!record.blobURL) + Number(!!record.sourceURL), 0),
            events: Object.fromEntries(eventCounts), player: controller?.getDiagnostics() };
    }

    return { start, stop, getDiagnostics };
}

// Node test exports
module.exports = { createVaftRuntime, workerBootstrap };
