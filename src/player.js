/* Player lifecycle, conservative controls and opt-in VOD range handling. */
function createPlayerController(env, options = {}, callbacks = {}) {
    const config = {
        debug: false,
        vodAdSkipping: false,
        activeIntervalMs: 600,
        idleIntervalMs: 2000,
        mutationDebounceMs: 150,
        minReloadMs: 8000,
        ...options,
        selectors: { player: '.video-player', reactRoot: '#root', ...options.selectors }
    };
    const win = env.window;
    const doc = env.document;
    const now = env.now || (() => Date.now());
    // No unverified signatures: never hide Twitch's native error/anti-adblock UI.
    const verifiedOverlayRules = Object.freeze([]);
    const reservedRoutes = new Set(['directory', 'downloads', 'inventory', 'jobs', 'login', 'logout', 'search', 'settings', 'signup', 'subscriptions', 'turbo', 'videos', 'wallet', 'collections', 'p', 'friends', 'messages', 'moderator', 'dashboard']);
    const videoEvents = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'emptied', 'loadstart', 'timeupdate', 'seeking', 'seeked'];
    const metrics = { scans: 0, reactScans: 0, ticks: 0, tasks: 0, vodSkips: 0, contexts: 0, diagnostics: 0 };
    const diagnosticTimes = new Map();
    let running = false;
    let suspended = false;
    let pollTimer = null;
    let mutationTimer = null;
    let observer = null;
    let observedRoot = null;
    let container = null;
    let video = null;
    let banner = null;
    let dirty = true;
    let route = '';
    let context = { kind: 'unknown', id: null, epoch: 0 };
    let status = { state: 'playing', hasAds: false, isMidroll: false };
    let reactCache;
    let reactCacheRetryAt = 0;
    let lastTaskAt = -Infinity;
    let internalAction = false;
    let expectedPause = null;
    let intentionalPause = false;
    let mediaWasLoaded = false;
    let restore = null;
    let progress = { position: null, at: 0, started: false };
    let vod = { ranges: [], reliable: false, attempts: new Set(), position: null, pausedByUs: false, expectedSeek: null };
    let quality = { locked: false, ending: false, recovery: null, mediaFence: null, readyAt: null, initial: null, pending: null, hook: null };

    // Store only stable, public quality attributes. Objects returned by an old
    // player/manifest must never be sent to a replacement player's decoder.
    function qualityDescriptor(value) {
        if (!value || typeof value !== 'object') return null;
        const result = {};
        for (const key of ['group', 'name', 'width', 'height', 'framerate', 'codecs']) {
            if (typeof value[key] === 'string' || Number.isFinite(value[key])) result[key] = value[key];
        }
        return Object.keys(result).length ? result : null;
    }

    function removeQualityHook() {
        const hook = quality.hook;
        if (!hook) return;
        for (const [name, record] of Object.entries(hook.methods)) {
            // Another extension may have wrapped our wrapper in the meantime.
            // Leave its method alone; our retired wrapper becomes a pass-through.
            try {
                if (hook.player[name] !== record.wrapper) continue;
                if (record.descriptor) Object.defineProperty(hook.player, name, record.descriptor);
                else delete hook.player[name];
            } catch { diagnose('quality-unhook-failed'); }
        }
        hook.active = false;
        quality.hook = null;
    }

    function resetQuality(restoreAuto = false) {
        const hook = quality.hook;
        if (restoreAuto && hook && quality.initial?.auto) {
            try {
                if (connected(video) && hook.player.getHTMLVideoElement() === video && hook.methods.setAutoQualityMode) {
                    Reflect.apply(hook.methods.setAutoQualityMode.original, hook.player, [true]);
                }
            } catch { diagnose('quality-auto-restore-failed'); }
        }
        removeQualityHook();
        quality = { locked: false, ending: false, recovery: null, mediaFence: null, readyAt: null, initial: null, pending: null, hook: null };
    }

    function hookIsCurrent(hook) {
        if (!hook.active || !quality.locked || quality.hook !== hook || context.kind !== 'live' ||
            !running || suspended || classify(pathname()).id !== context.id || !connected(video)) return false;
        try { return hook.player.getHTMLVideoElement() === video; } catch { return false; }
    }

    function currentQualityChoice(player) {
        try {
            if (player.isAutoQualityMode?.() === true) return { auto: true };
            const descriptor = qualityDescriptor(player.getQuality?.());
            return descriptor ? { auto: false, descriptor } : null;
        } catch { return null; }
    }

    function syncQualityGuard() {
        if (!quality.locked || context.kind !== 'live' || !video) return;
        const player = getPlayerAndState()?.player;
        // Quality interception needs a verified association, not merely the only
        // React candidate. Other scripts and mini-players keep their own APIs.
        try {
            if (!player || typeof player.getHTMLVideoElement !== 'function' || player.getHTMLVideoElement() !== video) return;
        } catch { return; }
        if (quality.hook?.player === player && quality.hook.active) return;
        removeQualityHook();
        if (!quality.initial) quality.initial = currentQualityChoice(player);
        const hook = { player, methods: {}, active: true };
        quality.hook = hook;
        for (const name of ['setQuality', 'setAutoQualityMode']) {
            if (typeof player[name] !== 'function') continue;
            const original = player[name];
            const descriptor = Object.getOwnPropertyDescriptor(player, name);
            const wrapper = function (...args) {
                if (!hookIsCurrent(hook) || this !== player) return Reflect.apply(original, this, args);
                // Source recovery may initialize its decoder through these same
                // setters. It is not a new menu choice and must not overwrite the
                // user's request or prevent the replacement decoder from starting.
                // setSrc may initialize asynchronously after its call returns.
                // Until fresh media is observed, allow that initialization but
                // retain the last menu choice recorded during the ad block.
                if (internalAction || (quality.ending && quality.recovery === 'waiting-media')) {
                    const initializationArgs = name === 'setAutoQualityMode' && !quality.ending && args[0] === true ? [false] : args;
                    return Reflect.apply(original, this, initializationArgs);
                }
                if (name === 'setQuality') {
                    const requested = qualityDescriptor(args[0]);
                    if (requested) quality.pending = { auto: false, descriptor: requested };
                    else diagnose('quality-choice-unrecognized');
                } else if (args[0] === true) quality.pending = { auto: true };
                else if (args[0] === false && !quality.pending?.descriptor) {
                    try {
                        const requested = qualityDescriptor(player.getQuality?.());
                        if (requested) quality.pending = { auto: false, descriptor: requested };
                    } catch { diagnose('quality-choice-unrecognized'); }
                }
                // SDK setters return void. In particular, do not forward a manual
                // choice before the clean fallback and its decoder are released.
                return undefined;
            };
            try {
                Object.defineProperty(player, name, { configurable: true, writable: true, value: wrapper });
                hook.methods[name] = { original, descriptor, wrapper };
            } catch { diagnose('quality-hook-unavailable'); }
        }
        // ABR must not change the rendition underneath the pinned clean fallback.
        // This does not issue setQuality or reset the source.
        try {
            if (player.isAutoQualityMode?.() === true && hook.methods.setAutoQualityMode) {
                Reflect.apply(hook.methods.setAutoQualityMode.original, player, [false]);
            }
        } catch { diagnose('quality-auto-freeze-failed'); }
    }

    function resolveQuality(player, descriptor) {
        let qualities;
        try { qualities = player.getQualities?.(); } catch { return null; }
        if (!Array.isArray(qualities)) return null;
        // Group identifies the menu choice (including Source). Dimensions are a
        // fallback when a refreshed manifest renames its variants.
        for (const keys of [['group'], ['name', 'height', 'framerate'], ['width', 'height', 'framerate']]) {
            if (keys.some(key => descriptor[key] === undefined || descriptor[key] === '')) continue;
            const matches = qualities.filter(item => item && keys.every(key => item[key] === descriptor[key]));
            if (matches.length === 1) return matches[0];
        }
        return null;
    }

    function finishQualityRecovery() {
        if (!quality.locked || !quality.ending || quality.recovery !== 'ready' || !video ||
            !(video.readyState > 0) || context.kind !== 'live') return false;
        if (quality.readyAt !== null && now() - quality.readyAt >= 8000) {
            // A vanished rendition must not leave the settings locked forever.
            // Keep the recovered video and restore its previous Auto preference;
            // never invent a substitute rendition or force another source reload.
            diagnose('quality-restore-expired');
            resetQuality(true);
            return false;
        }
        syncQualityGuard();
        const hook = quality.hook;
        if (!hook || !hookIsCurrent(hook)) return false;
        const choice = quality.pending || quality.initial;
        let method;
        let args;
        if (choice?.auto) {
            method = hook.methods.setAutoQualityMode?.original;
            args = [true];
        } else if (choice?.descriptor) {
            const resolved = resolveQuality(hook.player, choice.descriptor);
            if (!resolved) { diagnose('quality-choice-unavailable'); return false; }
            method = hook.methods.setQuality?.original;
            // Smooth switching is supported by the IVS SDK; use the fresh quality
            // object and avoid throwing away already buffered content.
            args = [resolved, true];
        }
        if (choice && !method) { diagnose('quality-restore-unavailable'); return false; }
        const settings = { muted: video.muted, volume: video.volume, paused: intentionalPause || video.paused };
        try {
            if (method) Reflect.apply(method, hook.player, args);
            resetQuality();
            return true;
        } catch { diagnose('quality-restore-failed'); return false; }
        finally {
            video.muted = settings.muted;
            video.volume = settings.volume;
            if (settings.paused && !video.paused) {
                expectedPause = video;
                video.pause();
            }
        }
    }

    function diagnose(code) {
        metrics.diagnostics++;
        if (!config.debug || !callbacks.onDiagnostic) return;
        if (diagnosticTimes.has(code) && now() - diagnosticTimes.get(code) < 5000) return;
        diagnosticTimes.set(code, now());
        if (diagnosticTimes.size > 32) diagnosticTimes.delete(diagnosticTimes.keys().next().value);
        // Only fixed codes and public context classification; no URLs or errors.
        try { callbacks.onDiagnostic({ code, kind: context.kind, epoch: context.epoch }); } catch {}
    }

    function pathname() {
        try { return new URL(win.location.href).pathname; } catch { return win.location.pathname || '/'; }
    }

    function classify(path) {
        // Network playback may start before the DOM video is attached.
        const vodMatch = path.match(/^\/videos\/(\d+)(?:\/|$)/i);
        if (vodMatch) return { kind: 'vod', id: vodMatch[1] };
        const liveMatch = path.match(/^\/(?:popout\/)?([a-z0-9_]{1,25})\/?$/i);
        if (liveMatch && !reservedRoutes.has(liveMatch[1].toLowerCase())) {
            return { kind: 'live', id: liveMatch[1].toLowerCase() };
        }
        return { kind: 'unknown', id: null };
    }

    function connected(node) { return !!node && node.isConnected !== false; }

    function resetVod() {
        vod = { ranges: [], reliable: false, attempts: new Set(), position: null, pausedByUs: false, expectedSeek: null };
    }

    function changeContext(next, mediaChanged) {
        if (!mediaChanged && next.kind === context.kind && next.id === context.id) return;
        const sameLive = next.kind === 'live' && context.kind === 'live' && next.id === context.id;
        if (!sameLive) resetQuality(true);
        context = { ...next, epoch: context.epoch + 1 };
        metrics.contexts++;
        resetVod();
        progress = { position: null, at: now(), started: false };
        reactCache = undefined;
        if (!sameLive) status = { state: 'playing', hasAds: false, isMidroll: false };
        renderStatus();
        try { callbacks.onContextChange?.({ ...context }); } catch { diagnose('context-callback-failed'); }
    }

    function removeBanner() {
        if (banner) banner.remove();
        banner = null;
    }

    function renderStatus() {
        const visible = !!container && (status.hasAds || status.state === 'error');
        if (!visible) {
            if (banner) banner.style.display = 'none';
            return;
        }
        if (!banner) {
            banner = doc.createElement('div');
            banner.setAttribute('data-vaft-status', '');
            banner.setAttribute('role', 'status');
            banner.setAttribute('aria-live', 'polite');
            banner.style.cssText = 'position:absolute;top:0;left:0;z-index:2;padding:5px 8px;color:white;background:rgba(0,0,0,.8);font:12px sans-serif;pointer-events:none;';
            container.appendChild(banner);
        }
        const label = status.state === 'error' ? 'Récupération du lecteur indisponible.' : 'Pub bloquée';
        if (banner.textContent !== label) banner.textContent = label;
        banner.style.display = 'block';
    }

    function applyRestore() {
        if (!restore || !video) return;
        if (restore.route !== route || now() > restore.expires) { restore = null; return; }
        video.muted = restore.muted;
        video.volume = restore.volume;
        // setSrc owns playback restart. Never force play after an async reload:
        // a pause event cannot reliably distinguish user intent from the player.
        if ((restore.paused || intentionalPause) && !video.paused) {
            expectedPause = video;
            video.pause();
        }
        restore = null;
    }

    function bindVideo(nextVideo, preservePause = false) {
        if (video === nextVideo) return false;
        removeQualityHook();
        const retainedPause = preservePause && intentionalPause;
        if (video) videoEvents.forEach(event => video.removeEventListener(event, onVideoEvent));
        video = nextVideo;
        mediaWasLoaded = !!video && (video.readyState > 0 || video.currentTime > 0);
        const initialBuffering = !!video && video.readyState === 0 && video.currentTime === 0;
        // A fresh HAVE_NOTHING video is paused by default. All subsequent pause
        // events remain protected, including a pause before metadata arrives.
        intentionalPause = retainedPause || (restore ? restore.paused : !!video?.paused && !initialBuffering);
        expectedPause = null;
        reactCache = undefined;
        progress = { position: null, at: now(), started: false };
        if (video) videoEvents.forEach(event => video.addEventListener(event, onVideoEvent));
        return true;
    }

    function observeTarget() {
        if (!running || suspended || !env.MutationObserver) return;
        const root = connected(container?.parentElement) ? container.parentElement : doc.querySelector(config.selectors.reactRoot) || doc.documentElement;
        if (root === observedRoot && observer) return;
        observer?.disconnect();
        observedRoot = root;
        if (!root) return;
        if (!observer) observer = new env.MutationObserver(onMutations);
        observer.observe(root, { childList: true, subtree: true });
    }

    function discover() {
        metrics.scans++;
        const players = [...doc.querySelectorAll(config.selectors.player)].filter(connected);
        let nextContainer = null;
        let nextVideo = null;
        let ambiguous = players.length > 1;
        if (players.length === 1) {
            const videos = [...players[0].querySelectorAll('video')].filter(connected);
            ambiguous = videos.length > 1;
            if (videos.length === 1) { nextContainer = players[0]; nextVideo = videos[0]; }
        }
        if (container !== nextContainer) { removeBanner(); container = nextContainer; }
        const nextRoute = pathname();
        if (nextRoute !== route) {
            restore = null;
            resetQuality(true);
        }
        // Replacing the DOM video on one route is not a new request to play,
        // even if the old element disappears before its replacement arrives.
        const mediaChanged = bindVideo(nextVideo, nextRoute === route);
        route = nextRoute;
        dirty = false;
        changeContext(ambiguous ? { kind: 'unknown', id: null } : classify(route), mediaChanged);
        observeTarget();
        if (mediaChanged) applyRestore();
        if (quality.locked) {
            syncQualityGuard();
            if (mediaChanged && video?.readyState > 0 && quality.ending && quality.recovery === 'waiting-media') {
                quality.recovery = 'ready';
                quality.readyAt = now();
                quality.mediaFence = null;
                if (!internalAction) finishQualityRecovery();
            }
        }
    }

    function refresh() {
        const nextRoute = pathname();
        if (nextRoute !== route || !connected(video) || !connected(container)) dirty = true;
        if (dirty) discover();
    }

    function isOwnNode(node) {
        return !!node && (node === banner || !!banner?.contains(node) || !!node.closest?.('[data-vaft-status]'));
    }

    function touchesPlayer(node) {
        if (!node || isOwnNode(node)) return false;
        if (node === video || node === container || node.contains?.(video) || node.contains?.(container)) return true;
        return !!(node.matches?.(`${config.selectors.player},video`) || node.querySelector?.(`${config.selectors.player},video`));
    }

    function onMutations(records) {
        const relevant = records.some(record => {
            if (isOwnNode(record.target)) return false;
            return [...(record.addedNodes || []), ...(record.removedNodes || [])].some(touchesPlayer);
        });
        if (!relevant) return;
        dirty = true;
        if (mutationTimer !== null) return;
        mutationTimer = env.setTimeout(() => {
            mutationTimer = null;
            if (!running || suspended) return;
            refresh();
            scheduleTick();
        }, config.mutationDebounceMs);
    }

    function safePlay(target) {
        try {
            const result = target.play();
            if (result && typeof result.catch === 'function') result.catch(() => diagnose('play-rejected'));
        } catch { diagnose('play-failed'); }
    }

    function onVideoEvent(event) {
        if (!running || suspended || event.target !== video) return;
        if (video.readyState > 0 || video.currentTime > 0 || event.type === 'loadedmetadata' || event.type === 'playing') {
            mediaWasLoaded = true;
        }
        const ownPause = event.type === 'pause' && expectedPause === video;
        if (ownPause) expectedPause = null;
        if (!internalAction && !ownPause && event.type === 'pause') {
            intentionalPause = true;
            vod.pausedByUs = false;
            if (restore) restore.paused = true;
        } else if (!internalAction && event.type === 'play') {
            intentionalPause = false;
            if (restore) restore.paused = false;
        }
        if (event.type === 'seeking' && !internalAction && video.paused &&
            !(vod.expectedSeek !== null && Math.abs(video.currentTime - vod.expectedSeek) < 0.25)) {
            intentionalPause = true;
            vod.pausedByUs = false;
        }
        if (event.type === 'seeked') vod.expectedSeek = null;
        if (event.type === 'loadedmetadata') applyRestore();
        if (['loadedmetadata', 'emptied', 'loadstart'].includes(event.type)) reactCache = undefined;
        if (quality.locked && ['loadedmetadata', 'playing', 'emptied', 'loadstart'].includes(event.type)) {
            syncQualityGuard();
            if (quality.ending && quality.recovery === 'waiting-media') {
                if (event.type === 'emptied' || event.type === 'loadstart') {
                    if (quality.mediaFence) quality.mediaFence.started = true;
                }
                // The old buffer can emit playing after an asynchronous setSrc.
                // Only fresh metadata, a replacement element, or a playing event
                // after an observed new-load boundary proves source recovery.
                const freshMedia = event.type === 'loadedmetadata' ||
                    (event.type === 'playing' && quality.mediaFence &&
                        (quality.mediaFence.video !== video || quality.mediaFence.started));
                if (freshMedia && video.readyState > 0) {
                    quality.recovery = 'ready';
                    quality.readyAt = now();
                    quality.mediaFence = null;
                }
            }
            if (!internalAction) finishQualityRecovery();
        }
        if (event.type === 'timeupdate' || event.type === 'seeking' || event.type === 'seeked' || event.type === 'play') {
            checkVod();
        }
        if (['play', 'pause', 'ended', 'loadedmetadata', 'emptied', 'loadstart'].includes(event.type)) scheduleTick();
    }

    function reactRoot() {
        const node = doc.querySelector(config.selectors.reactRoot);
        if (!node) return null;
        if (node._reactRootContainer?._internalRoot?.current) return node._reactRootContainer._internalRoot.current;
        const key = Object.keys(node).find(name => name.startsWith('__reactContainer'));
        return key ? node[key]?.current || node[key] : null;
    }

    function getPlayerAndState() {
        refresh();
        if (!video || !container) return null;
        const currentRoot = reactRoot();
        // An alternate commit can remount the component while its previous
        // instance still points at this video. Rescan once for each observed root
        // change; do not assume the cached component belongs to the current tree.
        if (reactCache?.player && currentRoot !== reactCache.root) reactCache = undefined;
        // Twitch can replace the SDK instance without replacing the DOM video.
        // Validate the few captured component pointers before trusting a positive
        // cache; an unchanged association needs no repeated React tree walk.
        if (reactCache?.player && !reactCache.associations.every(({ component, instance, player }) => {
            try {
                return component.props?.mediaPlayerInstance === instance &&
                    (instance.playerInstance || instance) === player &&
                    (!player.getHTMLVideoElement || player.getHTMLVideoElement() === video);
            } catch { return false; }
        })) reactCache = undefined;
        // React may hydrate after the video appears. Retry incomplete associations
        // only when needed, at the recovery cadence, instead of on every tick.
        if (reactCache !== undefined && ((reactCache.player && reactCache.state) || now() < reactCacheRetryAt)) {
            return { ...reactCache, video, container };
        }
        metrics.reactScans++;
        reactCacheRetryAt = now() + (quality.locked ? Math.min(config.minReloadMs, config.idleIntervalMs) : config.minReloadMs);
        const stack = [currentRoot].filter(Boolean);
        const seen = new Set();
        const players = new Set();
        const associations = [];
        const states = new Set();
        while (stack.length && seen.size < 10000) {
            const node = stack.pop();
            if (!node || seen.has(node)) continue;
            seen.add(node);
            if (node.child) stack.push(node.child);
            if (node.sibling) stack.push(node.sibling);
            const component = node.stateNode;
            if (!component) continue;
            if (component.setPlayerActive && component.props?.mediaPlayerInstance) {
                const instance = component.props.mediaPlayerInstance;
                const candidate = instance.playerInstance || instance;
                try {
                    if (!candidate.getHTMLVideoElement || candidate.getHTMLVideoElement() === video) {
                        players.add(candidate);
                        associations.push({ component, instance, player: candidate });
                    }
                } catch {}
            }
            if (typeof component.setSrc === 'function' && component.setInitialPlaybackSettings) states.add(component);
        }
        if (seen.size >= 10000) diagnose('react-scan-limit');
        // Refuse uncertain associations instead of commanding a second player.
        reactCache = {
            player: players.size === 1 ? [...players][0] : null,
            state: players.size === 1 && states.size === 1 ? [...states][0] : null,
            root: currentRoot,
            associations
        };
        return { ...reactCache, video, container };
    }

    function task({ reload = false, pausePlay = false, adRecovery = false } = {}) {
        refresh();
        // The end-of-ad reload is retained across pause, hydration and cooldown,
        // but is never issued a second time while metadata is being awaited.
        if (reload && adRecovery && quality.ending && quality.recovery !== 'reload-pending') return false;
        if (!running || suspended || !video || context.kind !== 'live' || video.ended || intentionalPause) return false;
        if (video.readyState > 0 || video.currentTime > 0) mediaWasLoaded = true;
        const startupRecovery = reload && adRecovery === true && !mediaWasLoaded && video.readyState === 0 && video.currentTime === 0;
        if (video.paused && !startupRecovery) return false;
        if ((!reload && !pausePlay) || now() - lastTaskAt < config.minReloadMs) return false;
        const current = getPlayerAndState();
        // Reload may let the player start naturally; never restore its default
        // startup pause as user intent and never issue play() for this recovery.
        const settings = { muted: video.muted, volume: video.volume, paused: video.paused && !startupRecovery };
        const target = current?.player && typeof current.player.pause === 'function' && typeof current.player.play === 'function' ? current.player : video;
        if (reload && !current?.state) { diagnose('reload-unavailable'); return false; }
        try {
            internalAction = true;
            if (reload) {
                restore = { ...settings, route, expires: now() + config.minReloadMs };
                if (adRecovery && quality.ending) {
                    quality.recovery = 'waiting-media';
                    quality.mediaFence = { video, started: false };
                }
                current.state.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
                video.muted = settings.muted;
                video.volume = settings.volume;
            } else {
                expectedPause = video;
                target.pause();
                safePlay(target);
                video.muted = settings.muted;
                video.volume = settings.volume;
            }
            lastTaskAt = now();
            progress.at = now();
            metrics.tasks++;
            return true;
        } catch {
            restore = null;
            if (adRecovery && quality.ending) {
                quality.recovery = 'reload-pending';
                quality.mediaFence = null;
            }
            diagnose('player-task-failed');
            return false;
        } finally {
            internalAction = false;
            finishQualityRecovery();
        }
    }

    function seekableEnd(end) {
        const ranges = video?.seekable;
        try {
            for (let index = 0; ranges && index < ranges.length; index++) {
                if (ranges.start(index) <= end && ranges.end(index) >= end) return true;
            }
        } catch {}
        return false;
    }

    function checkVod() {
        if (!config.vodAdSkipping || !video || context.kind !== 'vod' || !vod.reliable) return;
        const position = Number(video.currentTime);
        if (!Number.isFinite(position)) return;
        if (vod.position !== null && position < vod.position - 0.5) {
            for (const range of vod.ranges) if (position < range.end) vod.attempts.delete(range.id);
        }
        vod.position = position;
        const range = vod.ranges.find(item => item.start <= position && position < item.end);
        if (!range || vod.attempts.has(range.id)) return;
        if (!seekableEnd(range.end)) {
            status = { state: 'waiting-ad', hasAds: true, isMidroll: true };
            renderStatus();
            if (!video.paused) {
                internalAction = true;
                vod.pausedByUs = true;
                expectedPause = video;
                try { video.pause(); } finally { internalAction = false; }
            }
            diagnose('vod-range-unseekable');
            return;
        }
        const muted = video.muted;
        const volume = video.volume;
        const resume = vod.pausedByUs && !intentionalPause;
        vod.attempts.add(range.id);
        vod.expectedSeek = range.end;
        try {
            internalAction = true;
            video.currentTime = range.end;
            vod.position = range.end;
            metrics.vodSkips++;
            if (resume) safePlay(video);
            status = { state: 'resuming', hasAds: false, isMidroll: false };
            renderStatus();
        } catch { diagnose('vod-seek-failed'); }
        finally {
            video.muted = muted;
            video.volume = volume;
            vod.pausedByUs = false;
            internalAction = false;
        }
    }

    function setVodRanges(data) {
        refresh();
        if (!data || context.kind !== 'vod' || String(data.id) !== context.id || data.epoch !== context.epoch) return false;
        if (!config.vodAdSkipping || data.timelineReliable !== true) { resetVod(); return false; }
        const unique = new Map();
        for (const range of Array.isArray(data.ranges) ? data.ranges : []) {
            if (range?.confirmed !== true || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) continue;
            const id = String(range.id ?? `${range.start}:${range.end}`);
            unique.set(id, { id, start: range.start, end: range.end });
        }
        vod.ranges = [...unique.values()].sort((a, b) => a.start - b.start);
        vod.reliable = true;
        vod.attempts = new Set([...vod.attempts].filter(id => unique.has(id)));
        checkVod();
        return true;
    }

    function tick() {
        pollTimer = null;
        if (!running || suspended) return;
        metrics.ticks++;
        refresh();
        checkVod();
        if (quality.locked) {
            syncQualityGuard();
            if (quality.ending && quality.recovery === 'reload-pending') task({ reload: true, adRecovery: true });
            finishQualityRecovery();
        }
        if (video && context.kind === 'live' && !video.paused && !video.ended && !status.hasAds && status.state !== 'error') {
            const position = Number(video.currentTime);
            if (Number.isFinite(position)) {
                if (progress.position !== null && position > progress.position + 0.01) { progress.started = true; progress.at = now(); }
                if (progress.started && now() - progress.at >= config.activeIntervalMs * 8) task({ pausePlay: true });
                progress.position = position;
            }
        } else progress = { position: null, at: now(), started: false };
        scheduleTick();
    }

    function scheduleTick() {
        if (pollTimer !== null) env.clearTimeout(pollTimer);
        pollTimer = null;
        if (!running || suspended) return;
        const active = video && !video.paused && !video.ended;
        pollTimer = env.setTimeout(tick, active ? config.activeIntervalMs : config.idleIntervalMs);
    }

    function cleanupActive() {
        resetQuality(true);
        if (pollTimer !== null) env.clearTimeout(pollTimer);
        if (mutationTimer !== null) env.clearTimeout(mutationTimer);
        pollTimer = mutationTimer = null;
        observer?.disconnect();
        observer = null;
        observedRoot = null;
        bindVideo(null);
        removeBanner();
        container = null;
        restore = null;
        resetVod();
        dirty = true;
    }

    function onPageHide() {
        if (!running) return;
        suspended = true;
        cleanupActive();
        changeContext({ kind: 'unknown', id: null }, true);
    }

    function onPageShow() {
        if (!running || !suspended) return;
        suspended = false;
        refresh();
        scheduleTick();
    }

    function onNavigation() {
        dirty = true;
        if (running && !suspended) { refresh(); scheduleTick(); }
    }

    function start() {
        if (running) return;
        running = true;
        suspended = false;
        win.addEventListener('pagehide', onPageHide);
        win.addEventListener('pageshow', onPageShow);
        win.addEventListener('popstate', onNavigation);
        win.addEventListener('hashchange', onNavigation);
        refresh();
        scheduleTick();
    }

    function stop() {
        if (!running) return;
        running = false;
        suspended = false;
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('pageshow', onPageShow);
        win.removeEventListener('popstate', onNavigation);
        win.removeEventListener('hashchange', onNavigation);
        cleanupActive();
        changeContext({ kind: 'unknown', id: null }, true);
    }

    return {
        start, stop, task, getPlayerAndState,
        getContext() { return { ...context }; },
        setStatus(data = {}) {
            refresh();
            if ((data.id !== undefined && String(data.id) !== context.id) || (data.epoch !== undefined && data.epoch !== context.epoch)) return false;
            if (context.kind === 'live' && data.hasAds === true) {
                quality.locked = true;
                quality.ending = false;
                quality.recovery = null;
                quality.mediaFence = null;
                quality.readyAt = null;
                syncQualityGuard();
            } else if (context.kind === 'live' && quality.locked && data.adEnded === true && data.hasAds === false && !quality.ending) {
                quality.ending = true;
                quality.recovery = 'reload-pending';
            }
            status = { ...status, state: typeof data.state === 'string' ? data.state : status.state,
                hasAds: typeof data.hasAds === 'boolean' ? data.hasAds : status.hasAds,
                isMidroll: typeof data.isMidroll === 'boolean' ? data.isMidroll : status.isMidroll };
            renderStatus();
            return true;
        },
        setVodRanges,
        getDiagnostics() {
            return { running, suspended, context: { ...context }, status: { ...status },
                timerScheduled: pollTimer !== null, observerActive: !!observer, videoAttached: !!video,
                qualityLocked: quality.locked, qualityPending: !!quality.pending, qualityRecovery: quality.recovery,
                verifiedOverlayRules: verifiedOverlayRules.length, vodRanges: vod.ranges.length,
                vodAttempts: vod.attempts.size, metrics: { ...metrics } };
        }
    };
}

// Node test exports
module.exports = { createPlayerController };
