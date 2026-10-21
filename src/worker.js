// Self-contained Worker engine. Network/playlist factories are injected explicitly.
function createWorkerEngine(env, config, createNetworkTools, createHlsTools, initialContext, workerId) {
    const net = createNetworkTools(env);
    const hls = createHlsTools();
    const realFetch = env.fetch.bind(env);
    const protocol = 'vaft-matteo:1';
    let context = { ...initialContext };
    let serial = 0;
    let adSerial = 0;
    let stopped = false;
    let simulateAds = false;
    const pending = new Map();
    const streams = new Map();
    const media = new Map();
    const blockedSegments = new Map();
    const controllers = new Set();
    const processedResponses = new WeakSet();
    const variantProbeTimeoutMs = 2000;
    const candidateLimit = 4;
    const now = () => env.Date ? env.Date.now() : Date.now();
    const error = name => new env.DOMException(name, name);
    const send = (type, data = {}) => env.postMessage({ namespace: protocol, workerId, epoch: context.epoch, type, ...data });
    const liveChannel = channel => context.kind === 'live' && context.id?.toLowerCase() === channel?.toLowerCase();

    function prune(map) {
        const oldest = now() - config.cacheTtlMs;
        for (const [key, value] of map) if (value.at < oldest) map.delete(key);
        while (map.size > config.maxCacheEntries) map.delete(map.keys().next().value);
    }

    function removeStream(id, stream) {
        env.clearTimeout(stream.retryTimer);
        stream.searchController?.abort();
        stream.refreshController?.abort();
        stream.recoveryController?.abort();
        streams.delete(id);
        for (const [url, entry] of media) if (entry.stream === stream) media.delete(url);
    }

    function pruneStreams() {
        const oldest = now() - config.cacheTtlMs;
        for (const [id, stream] of streams) {
            const current = context.kind === stream.kind && String(context.id).toLowerCase() === String(id).toLowerCase();
            if (!current && (stream.at < oldest || streams.size > config.maxCacheEntries)) removeStream(id, stream);
        }
    }

    function remember(map, key, value) {
        map.delete(key);
        map.set(key, { ...value, at: now() });
        prune(map);
    }

    function settle(id, failure, value) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        env.clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.onAbort);
        if (failure) entry.reject(failure); else entry.resolve(value);
    }

    function token(channel, playerType, signal) {
        if (signal?.aborted || stopped) return Promise.reject(error('AbortError'));
        const id = ++serial;
        return new Promise((resolve, reject) => {
            const onAbort = () => { send('cancel-token', { id }); settle(id, error('AbortError')); };
            const timer = env.setTimeout(() => {
                send('cancel-token', { id });
                settle(id, error('TimeoutError'));
            }, config.requestTimeoutMs);
            pending.set(id, { resolve, reject, signal, onAbort, timer });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) { onAbort(); return; }
            send('token', { id, channel, playerType });
        });
    }

    function setContext(next) {
        if (!next || !Number.isSafeInteger(next.epoch) || !['live', 'vod', 'unknown'].includes(next.kind)) return;
        if (next.epoch === context.epoch && next.kind === context.kind && next.id === context.id) return;
        for (const id of pending.keys()) { send('cancel-token', { id }); settle(id, error('AbortError')); }
        for (const controller of controllers) controller.abort();
        controllers.clear();
        for (const [id, stream] of streams) {
            env.clearTimeout(stream.retryTimer);
            stream.retryTimer = null;
            // A decoder replacement on the same channel must retain the codec fallback.
            if (next.kind === stream.kind && String(next.id).toLowerCase() === String(id).toLowerCase()) {
                stream.epoch = next.epoch;
                stream.job = null;
                stream.recoveryController = null;
                stream.refreshController = null;
                stream.generation++;
            } else removeStream(id, stream);
        }
        for (const [url, entry] of media) if (!streams.has(entry.stream.id)) media.delete(url);
        blockedSegments.clear();
        context = { ...next };
        simulateAds = false;
        // An empty waiting manifest can stop native polling. Re-arm the retained
        // channel's recovery under the new epoch when its video/decoder changes.
        for (const stream of streams.values()) if (stream.hadAds) {
            status(stream, stream.state, true);
            scheduleRecovery(stream, stream.recoveryTarget);
        }
    }

    function onMessage(event) {
        const message = event.data;
        if (message?.namespace !== protocol || message.workerId !== workerId) return;
        if (message.type === 'context') { setContext(message.context); return; }
        if (message.epoch !== context.epoch) return;
        if (message.type === 'shutdown') { stop(); return; }
        if (message.type === 'token-result' && Number.isSafeInteger(message.id)) {
            if (message.error) settle(message.id, error(message.error === 'TimeoutError' ? 'TimeoutError' : 'AbortError'));
            else if (typeof message.value === 'string' && typeof message.signature === 'string') {
                settle(message.id, null, { value: message.value, signature: message.signature });
            } else settle(message.id, error('DataError'));
        } else if (config.debug && message.type === 'simulate-ads') simulateAds = message.enabled === true;
    }

    function registerMaster(url, text, kind, epoch) {
        if (epoch !== context.epoch) return;
        const variants = hls.parseMaster(text, url.href);
        const id = kind.kind === 'live-master' ? kind.channel : kind.vodId;
        if (!id) return;
        let stream = streams.get(id);
        if (!stream) {
            stream = { id, kind: kind.kind === 'live-master' ? 'live' : 'vod', url: url.href,
                epoch, state: 'playing', attempt: 0, nextRetry: 0, job: null, backup: null,
                adSession: 0, hadAds: false, codecFallback: false, variants, retryTimer: null, recoveryTarget: null, recoveryRevision: 0, generation: 0, at: now() };
            streams.set(id, stream);
        }
        stream.url = url.href;
        // Signed media URLs can rotate without changing the chosen rendition.
        // Rebind only an unambiguous exact rendition; a different quality cannot
        // redefine what proves the end of this ad session.
        const pinned = stream.recoveryTarget;
        if (stream.hadAds && pinned && !variants.some(variant => variant.Url === pinned.Url)) {
            const matches = variants.filter(variant => pinned.Codecs && pinned.Resolution &&
                variant.Codecs === pinned.Codecs && variant.Resolution === pinned.Resolution && variant.FrameRate === pinned.FrameRate);
            if (matches.length === 1) {
                stream.recoveryTarget = matches[0];
                stream.recoveryRevision++;
                stream.recoveryController?.abort();
                stream.recoveryController = null;
                env.clearTimeout(stream.retryTimer);
                stream.retryTimer = null;
                scheduleRecovery(stream, stream.recoveryTarget);
            }
        }
        stream.variants = variants;
        stream.at = now();
        for (const variant of variants) remember(media, variant.Url, { stream, variant });
        pruneStreams();
        return stream;
    }

    function status(stream, state, hasAds = stream.hadAds, details = {}) {
        stream.state = state;
        if (stream.epoch === context.epoch) send('status', {
            state, hasAds, channel: stream.id,
            adSession: hasAds || details.adEnded ? stream.adSession : 0, ...details
        });
    }

    function reload(stream) {
        send('reload', { channel: stream.id, adSession: stream.adSession, adEnded: !stream.hadAds });
    }

    function finishAd(stream) {
        stream.generation++;
        stream.searchController?.abort();
        stream.recoveryController?.abort();
        stream.refreshController?.abort();
        env.clearTimeout(stream.retryTimer);
        stream.retryTimer = null;
        stream.hadAds = false;
        stream.recoveryTarget = null;
        stream.codecFallback = false;
        stream.backup = null;
        stream.job = null;
        stream.attempt = 0;
        stream.nextRetry = 0;
        status(stream, 'resuming', false, { adEnded: true, clean: true });
        reload(stream);
    }

    function codecFamily(codecs) {
        const value = (codecs || '').toLowerCase();
        if (/(^|,)\s*(hvc|hev)/.test(value)) return 'hevc';
        if (/(^|,)\s*avc/.test(value)) return 'avc';
        if (/(^|,)\s*av0/.test(value)) return 'av1';
        return null;
    }

    function fallbackMaster(stream, text, base) {
        const safe = stream.variants.filter(variant => ['avc', 'av1'].includes(codecFamily(variant.Codecs)));
        if (!safe.length) return text;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
            const attributes = hls.parseAttributes(lines[i]);
            if (codecFamily(attributes.CODECS) !== 'hevc') continue;
            const selected = hls.selectVariant(safe, { Resolution: attributes.RESOLUTION, FrameRate: Number(attributes['FRAME-RATE']) });
            if (!selected) continue;
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            if (next >= lines.length || lines[next].startsWith('#')) continue;
            lines[i] = lines[i].replace(/CODECS="[^"]*"/, `CODECS="${selected.Codecs}"`);
            if (selected.Resolution) lines[i] = lines[i].replace(/RESOLUTION=[^,\s]+/, `RESOLUTION=${selected.Resolution}`);
            if (selected.FrameRate) lines[i] = lines[i].replace(/FRAME-RATE=[^,\s]+/, `FRAME-RATE=${selected.FrameRate}`);
            // Keep separate variant identifiers without modifying the server's signed query.
            lines[next] = selected.Url + ' '.repeat(i + 1);
        }
        return absolutize(lines.join('\n'), base);
    }

    function absolutize(text, base) {
        return text.split(/\r?\n/).map(line => {
            if (line.trim() && !line.startsWith('#')) {
                return net.readFetchURL(line.trim(), base)?.href || line;
            }
            return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                const url = net.readFetchURL(uri, base);
                return url ? `URI="${url.href}"` : match;
            });
        }).join('\n');
    }

    function waitingManifest(text) {
        // A finite response which exposes no media URI. Keep live polling possible.
        const version = text.match(/^#EXT-X-VERSION:\d+/m)?.[0] || '#EXT-X-VERSION:3';
        const target = text.match(/^#EXT-X-TARGETDURATION:\d+/m)?.[0] || '#EXT-X-TARGETDURATION:2';
        const sequence = text.match(/^#EXT-X-MEDIA-SEQUENCE:\d+/m)?.[0] || '#EXT-X-MEDIA-SEQUENCE:0';
        return ['#EXTM3U', version, target, sequence, ''].join('\n');
    }

    async function auxiliary(url, signal, timeoutMs = config.requestTimeoutMs) {
        const result = await net.requestText(realFetch, url, { signal }, timeoutMs);
        if (!result.response.ok || !result.text.trimStart().startsWith('#EXTM3U')) throw error('DataError');
        return result.text;
    }

    function variantArea(variant) {
        const size = String(variant?.Resolution || '').match(/^(\d+)x(\d+)$/i);
        const area = size ? Number(size[1]) * Number(size[2]) : 0;
        return Number.isFinite(area) ? area : 0;
    }

    function compatibleVariants(variants, target) {
        const family = codecFamily(target?.Codecs);
        if (!family) return [];
        const urls = new Set();
        return variants.filter(variant => {
            if (!variant.Url || urls.has(variant.Url) || !variantArea(variant) || codecFamily(variant.Codecs) !== family) return false;
            urls.add(variant.Url);
            return true;
        });
    }

    function fitsTarget(variant, target) {
        const area = variantArea(variant);
        const limit = variantArea(target);
        const family = codecFamily(target?.Codecs);
        return !!family && codecFamily(variant?.Codecs) === family && area > 0 && (!limit || area <= limit);
    }

    function chooseCandidates(variants, target, round = 0) {
        const pool = variants.filter(variant => fitsTarget(variant, target));
        const preferred = hls.selectVariant(pool, target || {});
        if (!preferred) return [];
        const chosen = [preferred];
        const remaining = pool.filter(variant => variant.Url !== preferred.Url)
            .sort((a, b) => variantArea(b) - variantArea(a));
        // Always consider a small usable picture, even when the highest quality stalls.
        if (remaining.length) chosen.push(remaining.pop());
        const offset = remaining.length ? (round * (candidateLimit - 2)) % remaining.length : 0;
        const count = Math.min(candidateLimit - chosen.length, remaining.length);
        for (let index = 0; index < count; index++) {
            chosen.push(remaining[(offset + index) % remaining.length]);
        }
        return chosen;
    }

    async function probeVariants(candidates, signal) {
        if (!candidates.length) return null;
        const controller = new env.AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) controller.abort();
        let index = 0;
        const probe = async () => {
            while (!controller.signal.aborted && index < candidates.length) {
                const variant = candidates[index++];
                try {
                    // Release a stalled slot soon enough to try intermediate qualities
                    // within the outer search's unchanged total deadline.
                    const text = await auxiliary(variant.Url, controller.signal, Math.min(variantProbeTimeoutMs, config.requestTimeoutMs));
                    const inspection = hls.inspectMedia(text, variant.Url);
                    if (!inspection.hasAds && !simulateAds && inspection.segments.length) {
                        return { url: variant.Url, variant, text: absolutize(inspection.sanitizedText, variant.Url), at: now() };
                    }
                } catch (failure) {
                    if (controller.signal.aborted) throw failure;
                }
            }
            throw error('DataError');
        };
        try {
            // Only two requests run at once; the first clean result releases the player.
            return await Promise.any(Array.from({ length: Math.min(2, candidates.length) }, probe));
        } catch (failure) {
            if (signal.aborted) throw error('AbortError');
            return null;
        } finally {
            signal.removeEventListener('abort', onAbort);
            controller.abort();
        }
    }

    async function search(stream, target, signal) {
        // One total deadline also bounds the sequence of fallback requests.
        // Rotate the first profile so one stalled token/master cannot starve the rest.
        for (let index = 0; index < config.backupPlayerTypes.length; index++) {
            const playerType = config.backupPlayerTypes[(stream.attempt + index) % config.backupPlayerTypes.length];
            if (signal.aborted || stream.epoch !== context.epoch) throw error('AbortError');
            try {
                const access = await token(stream.id, playerType, signal);
                const url = new env.URL(stream.url);
                url.searchParams.delete('parent_domains');
                url.searchParams.set('sig', access.signature);
                url.searchParams.set('token', access.value);
                const master = await auxiliary(url.href, signal);
                const variants = hls.parseMaster(master, url.href);
                // Do not splice incompatible codecs into a running decoder.
                const compatible = compatibleVariants(variants, target);
                const result = await probeVariants(chooseCandidates(compatible, target, stream.attempt), signal);
                if (result) return result;
            } catch (failure) {
                if (signal.aborted) throw failure;
            }
        }
        return null;
    }

    function beginSearch(stream, target) {
        if (stream.job) return stream.job;
        if (now() < stream.nextRetry) return Promise.resolve(null);
        status(stream, 'searching', true);
        const controller = new env.AbortController();
        controllers.add(controller);
        stream.searchController = controller;
        const timer = env.setTimeout(() => controller.abort(), config.requestTimeoutMs);
        const epoch = context.epoch;
        const generation = stream.generation;
        const job = search(stream, target, controller.signal).catch(() => null).then(result => {
            if (epoch !== context.epoch || generation !== stream.generation) return null;
            if (result) {
                stream.backup = result;
                stream.attempt = 0;
                stream.nextRetry = 0;
                status(stream, 'playing', true);
            } else {
                const index = Math.min(stream.attempt++, config.retryDelaysMs.length - 1);
                stream.nextRetry = now() + config.retryDelaysMs[index];
                status(stream, 'waiting-ad', true);
                scheduleRecovery(stream, target);
            }
            return result;
        }).finally(() => {
            env.clearTimeout(timer);
            controllers.delete(controller);
            if (stream.searchController === controller) stream.searchController = null;
            if (stream.job === job) stream.job = null;
        });
        stream.job = job;
        return job;
    }

    function scheduleRecovery(stream, target) {
        if (stream.retryTimer || stream.recoveryController || !target?.Url || stopped || !stream.hadAds) return;
        const epoch = context.epoch;
        const generation = stream.generation;
        stream.retryTimer = env.setTimeout(async () => {
            stream.retryTimer = null;
            if (epoch !== context.epoch || !liveChannel(stream.id) || !stream.hadAds) return;
            const currentTarget = stream.recoveryTarget || target;
            const recoveryRevision = stream.recoveryRevision;
            const controller = new env.AbortController();
            controllers.add(controller);
            stream.recoveryController = controller;
            try {
                const text = await auxiliary(currentTarget.Url, controller.signal);
                if (epoch !== context.epoch || generation !== stream.generation || recoveryRevision !== stream.recoveryRevision || !stream.hadAds) return;
                const inspection = hls.inspectMedia(text, currentTarget.Url);
                if (!inspection.hasAds && !simulateAds && inspection.segments.length) {
                    finishAd(stream);
                    return;
                }
                const wasWaiting = stream.state !== 'playing';
                const result = await backupText(stream, currentTarget);
                if (epoch === context.epoch && generation === stream.generation && result && wasWaiting) reload(stream);
            } catch {
                if (epoch !== context.epoch || generation !== stream.generation || recoveryRevision !== stream.recoveryRevision) return;
                const index = Math.min(stream.attempt++, config.retryDelaysMs.length - 1);
                stream.nextRetry = now() + config.retryDelaysMs[index];
            } finally {
                controllers.delete(controller);
                if (stream.recoveryController === controller) stream.recoveryController = null;
                if (epoch === context.epoch && generation === stream.generation && stream.hadAds) scheduleRecovery(stream, stream.recoveryTarget);
            }
        }, Math.max(config.retryDelaysMs[0], stream.nextRetry - now()));
    }

    async function backupText(stream, target) {
        const epoch = context.epoch;
        const generation = stream.generation;
        const sameCodec = variant => !!codecFamily(target?.Codecs) && codecFamily(variant?.Codecs) === codecFamily(target.Codecs);
        const cached = stream.backup;
        if (cached) {
            // A stray request for another quality must not replace the working
            // fallback. A different codec cannot be spliced into that decoder.
            if (!sameCodec(cached.variant)) return null;
            if (now() - cached.at < 500) return cached.text;
            if (!stream.job) {
                const controller = new env.AbortController();
                controllers.add(controller);
                stream.refreshController = controller;
                const job = auxiliary(cached.url, controller.signal).then(text => {
                    if (epoch !== context.epoch || generation !== stream.generation || stream.backup !== cached) throw error('AbortError');
                    const inspection = hls.inspectMedia(text, cached.url);
                    if (inspection.hasAds || simulateAds || !inspection.segments.length) return null;
                    cached.text = absolutize(inspection.sanitizedText, cached.url);
                    cached.at = now();
                    return cached;
                }).catch(() => null).finally(() => {
                    controllers.delete(controller);
                    if (stream.refreshController === controller) stream.refreshController = null;
                    if (stream.job === job) stream.job = null;
                });
                stream.job = job;
            }
            const refreshed = await stream.job;
            if (epoch !== context.epoch || generation !== stream.generation) throw error('AbortError');
            if (refreshed && sameCodec(refreshed.variant)) return refreshed.text;
            if (stream.backup === cached) stream.backup = null;
        }
        // Preserve the initial resolution preference even if an in-flight
        // request for a different quality arrives while the player is locked.
        const pinned = stream.recoveryTarget;
        const searchTarget = pinned && sameCodec(pinned) ? pinned : target;
        const result = await beginSearch(stream, searchTarget);
        if (epoch !== context.epoch || generation !== stream.generation) throw error('AbortError');
        return result && sameCodec(result.variant) ? result.text : null;
    }

    async function processMedia(stream, variant, url, text, requestState) {
        const epoch = context.epoch;
        const inspection = hls.inspectMedia(text, url.href);
        if (stream.kind === 'vod') {
            if (context.kind === 'vod' && String(context.id) === String(stream.id)) {
                send('vod-ranges', { id: stream.id, ranges: inspection.vodRanges, timelineReliable: inspection.timelineReliable });
                if (config.debug && inspection.hasAds) send('diagnostic', { code: 'vod-ad-observed', count: inspection.vodRanges.length });
            }
            return text; // Preserve VOD timeline and TwitchNoSub's response.
        }
        if (!liveChannel(stream.id)) return text;
        const fresh = requestState.generation === stream.generation;
        // Requests already in flight when this ad started may join its fallback,
        // but can never end it. Results from an older completed ad are discarded.
        if (!fresh && !(stream.hadAds && !requestState.hadAds && requestState.generation === stream.generation - 1)) {
            throw error('AbortError');
        }
        const hasAds = inspection.hasAds || simulateAds;
        if (!hasAds && !stream.hadAds) {
            if (inspection.segments.length) status(stream, 'playing', false, { clean: true });
            return inspection.sanitizedText;
        }
        if (!hasAds && fresh && inspection.segments.length && url.href === stream.recoveryTarget?.Url) {
            finishAd(stream);
            return inspection.sanitizedText;
        }
        if (!stream.hadAds) {
            stream.hadAds = true;
            stream.adSession = ++adSerial;
            stream.generation++;
            stream.recoveryTarget = variant;
            // Lock the page player before any decoder replacement is requested.
            status(stream, 'searching', true);
        }
        const generation = stream.generation;
        for (const segment of inspection.segments) if (segment.isAd) remember(blockedSegments, segment.url, {});
        if (codecFamily(variant?.Codecs) === 'hevc' && !stream.codecFallback &&
            stream.variants.some(item => ['avc', 'av1'].includes(codecFamily(item.Codecs)))) {
            stream.codecFallback = true;
            reload(stream);
        }
        const clean = await backupText(stream, variant);
        if (epoch !== context.epoch || generation !== stream.generation) throw error('AbortError');
        scheduleRecovery(stream, stream.recoveryTarget);
        if (clean) return clean;
        if (!stream.backup) status(stream, 'waiting-ad', true);
        return waitingManifest(text);
    }

    async function wrappedFetch(input, init, fetcher = realFetch) {
        const url = net.readFetchURL(input, env.location?.href);
        if (!url || stopped) return fetcher(input, init);
        prune(blockedSegments);
        if (blockedSegments.has(url.href)) throw error('AbortError');
        const kind = hls.classifyManifestURL(url.href);
        if (kind.kind === 'other') return fetcher(input, init);
        const epoch = context.epoch;
        // Only inspect known playback manifests. Unrelated .m3u8 requests pass through.
        const known = media.get(url.href);
        const master = kind.kind === 'live-master' || kind.kind === 'vod-master';
        if (!master && !known) return fetcher(input, init);
        const requestState = known ? { generation: known.stream.generation, hadAds: known.stream.hadAds } : null;
        const response = await fetcher(input, init);
        if (!response.ok) return response;
        if (processedResponses.has(response)) return response;
        // VOD diagnostics are opt-in too: long VOD playlists must not be cloned by default.
        const isVod = kind.kind === 'vod-master' || known?.stream.kind === 'vod';
        if (isVod && !config.debug && !config.vodAdSkipping) return response;
        if (epoch !== context.epoch) throw error('AbortError');
        const signal = init?.signal ?? (input instanceof env.Request ? input.signal : undefined);
        let text;
        try {
            ({ text } = await net.requestText(() => Promise.resolve(response.clone()), url.href, { signal }, config.requestTimeoutMs));
        } catch (failure) {
            // Optional VOD diagnostics never interrupt TwitchNoSub playback.
            if (isVod && !signal?.aborted) return response;
            throw failure;
        }
        if (epoch !== context.epoch) throw error('AbortError');
        if (!text.trimStart().startsWith('#EXTM3U')) return response;
        let changed = text;
        if (master) {
            const stream = registerMaster(url, text, kind, epoch);
            if (stream?.kind === 'live' && liveChannel(stream.id) && stream.codecFallback) changed = fallbackMaster(stream, text, url.href);
        } else {
            const processing = processMedia(known.stream, known.variant, url, text, requestState);
            let onAbort;
            try {
                const aborting = new Promise((resolve, reject) => {
                    onAbort = () => reject(signal.reason || error('AbortError'));
                    signal?.addEventListener('abort', onAbort, { once: true });
                    if (signal?.aborted) onAbort();
                });
                changed = await Promise.race([processing, aborting]);
            } finally { signal?.removeEventListener('abort', onAbort); }
        }
        if (epoch !== context.epoch) throw error('AbortError');
        const result = net.replaceResponseText(response, text, changed);
        processedResponses.add(result);
        return result;
    }

    function start() {
        env.addEventListener('message', onMessage);
        env.fetch = wrappedFetch;
    }

    function stop() {
        stopped = true;
        setContext({ kind: 'unknown', id: null, epoch: context.epoch + 1 });
        env.removeEventListener('message', onMessage);
        if (env.fetch === wrappedFetch) env.fetch = realFetch;
    }

    function refreshFetch() {
        if (env.fetch === wrappedFetch) return;
        // A later TwitchNoSub wrapper can synthesize a VOD response after our inner hook.
        const nextFetch = env.fetch.bind(env);
        env.fetch = (input, init) => wrappedFetch(input, init, nextFetch);
    }

    return { start, stop, setContext, refreshFetch, handleFetch: wrappedFetch, waitingManifest,
        getDiagnostics: () => ({ pending: pending.size, streams: streams.size, media: media.size,
            blockedSegments: blockedSegments.size, controllers: controllers.size,
            recoveryTimers: [...streams.values()].filter(stream => stream.retryTimer).length, epoch: context.epoch }) };
}

// Node test exports
module.exports = { createWorkerEngine };
