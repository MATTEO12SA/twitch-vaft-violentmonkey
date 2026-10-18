const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerController } = require('../src/player.js');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this }); }
    listenerCount() { return [...this.listeners.values()].reduce((sum, items) => sum + items.size, 0); }
}

class Element extends Events {
    constructor(tag, { id = '', className = '' } = {}) {
        super();
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.className = className;
        this.parentElement = null;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.textContent = '';
    }
    get isConnected() { return this.documentRoot === true || !!this.parentElement?.isConnected; }
    appendChild(node) {
        node.remove();
        this.children.push(node);
        node.parentElement = this;
        return node;
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
        this.parentElement = null;
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    matches(selector) {
        return selector.split(',').some(part => {
            const item = part.trim();
            if (item.startsWith('.')) return this.className.split(' ').includes(item.slice(1));
            if (item.startsWith('#')) return this.id === item.slice(1);
            if (item.startsWith('[')) return Object.hasOwn(this.attributes, item.slice(1, -1));
            return this.tagName.toLowerCase() === item;
        });
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
}

class Video extends Element {
    constructor() {
        super('video');
        this.paused = false;
        this.ended = false;
        this.currentTime = 0;
        this.volume = 0.3;
        this.muted = true;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.setSeekable([[0, 100]]);
    }
    setSeekable(ranges) { this.seekable = { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] }; }
    pause() {
        this.pauseCalls++;
        if (!this.paused) { this.paused = true; this.emit('pause'); }
    }
    play() {
        this.playCalls++;
        if (this.paused) { this.paused = false; this.emit('play'); }
        return Promise.resolve();
    }
}

function setup(options = {}, path = '/channel') {
    let timestamp = 0;
    let timerId = 0;
    const timers = new Map();
    const observers = [];
    const contexts = [];
    const diagnostics = [];
    const html = new Element('html');
    html.documentRoot = true;
    const root = html.appendChild(new Element('div', { id: 'root' }));
    const playerContainer = root.appendChild(new Element('div', { className: 'video-player' }));
    const video = playerContainer.appendChild(new Video());
    const win = new Events();
    win.location = { href: `https://www.twitch.tv${path}` };
    const doc = {
        documentElement: html,
        querySelector: selector => html.querySelector(selector),
        querySelectorAll: selector => html.querySelectorAll(selector),
        createElement: tag => new Element(tag)
    };
    class Observer {
        constructor(callback) { this.callback = callback; this.active = false; this.observeCalls = 0; observers.push(this); }
        observe(target, settings) { this.active = true; this.target = target; this.settings = settings; this.observeCalls++; }
        disconnect() { this.active = false; }
        emit(records) { if (this.active) this.callback(records); }
    }
    const env = {
        window: win, document: doc, MutationObserver: Observer, now: () => timestamp,
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: timestamp + delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    const controller = createPlayerController(env, options, {
        onContextChange: value => contexts.push(value), onDiagnostic: value => diagnostics.push(value)
    });
    function advance(ms) {
        const until = timestamp + ms;
        let count = 0;
        while (true) {
            const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(count++ < 1000, 'timer loop is bounded');
            timestamp = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        }
        timestamp = until;
    }
    function mutate(addedNodes, removedNodes = [], target = root) {
        observers.filter(item => item.active).forEach(item => item.emit([{ target, addedNodes, removedNodes }]));
    }
    function addReact() {
        const player = { getHTMLVideoElement: () => video, pause: () => video.pause(), play: () => video.play() };
        const state = { calls: 0, setSrc() { this.calls++; }, setInitialPlaybackSettings() {} };
        root._reactRootContainer = { _internalRoot: { current: {
            stateNode: { setPlayerActive() {}, props: { mediaPlayerInstance: player } },
            child: { stateNode: state }
        } } };
        return { player, state };
    }
    return { controller, win, doc, root, html, playerContainer, video, timers, observers, contexts, diagnostics, advance, mutate, addReact };
}

function setRanges(fixture, ranges = [{ id: 'ad-1', start: 10, end: 20, confirmed: true }], extra = {}) {
    const context = fixture.controller.getContext();
    return fixture.controller.setVodRanges({ id: context.id, epoch: context.epoch, ranges, timelineReliable: true, ...extra });
}

test('start is idempotent; stop clears timers, observers and all listeners', () => {
    const f = setup();
    f.controller.start();
    f.controller.start();
    assert.equal(f.observers.filter(item => item.active).length, 1);
    assert.equal(f.timers.size, 1);
    assert.deepEqual(f.controller.getContext(), { kind: 'live', id: 'channel', epoch: 1 });
    f.controller.stop();
    f.controller.stop();
    assert.equal(f.timers.size, 0);
    assert.equal(f.observers.filter(item => item.active).length, 0);
    assert.equal(f.video.listenerCount(), 0);
    assert.equal(f.win.listenerCount(), 0);
});

test('active and idle polling avoid DOM/React rescans on ordinary ticks', () => {
    const f = setup();
    f.controller.start();
    const scans = f.controller.getDiagnostics().metrics.scans;
    f.advance(1800);
    assert.equal(f.controller.getDiagnostics().metrics.ticks, 3);
    assert.equal(f.controller.getDiagnostics().metrics.scans, scans);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 0);
    f.video.pause();
    f.advance(1999);
    assert.equal(f.controller.getDiagnostics().metrics.ticks, 3);
    f.advance(1);
    assert.equal(f.controller.getDiagnostics().metrics.ticks, 4);
});

test('frequent timeupdate events do not postpone watchdog ticks indefinitely', () => {
    const f = setup();
    f.controller.start();
    for (let index = 0; index < 12; index++) { f.video.emit('timeupdate'); f.advance(200); }
    assert.equal(f.controller.getDiagnostics().metrics.ticks, 4);
});

test('SPA route changes update live/VOD context without patching browser history', () => {
    const f = setup();
    f.controller.start();
    f.win.location.href = 'https://www.twitch.tv/videos/1234';
    f.advance(600);
    assert.deepEqual(f.controller.getContext(), { kind: 'vod', id: '1234', epoch: 2 });
    f.win.location.href = 'https://www.twitch.tv/other_channel';
    f.advance(600);
    assert.deepEqual(f.controller.getContext(), { kind: 'live', id: 'other_channel', epoch: 3 });
});

test('ambiguous players or multiple videos are never controlled', () => {
    const f = setup();
    f.playerContainer.appendChild(new Video());
    f.controller.start();
    assert.equal(f.controller.getContext().kind, 'unknown');
    assert.equal(f.controller.task({ pausePlay: true }), false);
    assert.equal(f.video.pauseCalls, 0);
    const g = setup();
    g.root.appendChild(new Element('div', { className: 'video-player' })).appendChild(new Video());
    g.controller.start();
    assert.equal(g.controller.getPlayerAndState(), null);
});

test('replacement media invalidates React cache and advances context once after debouncing', () => {
    const f = setup();
    f.addReact();
    f.controller.start();
    f.controller.getPlayerAndState();
    const replacement = new Video();
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    f.mutate([replacement], [f.video]);
    f.mutate([replacement]);
    f.advance(149);
    assert.equal(f.controller.getContext().epoch, 1);
    f.advance(1);
    assert.equal(f.controller.getContext().epoch, 2);
    assert.equal(f.video.listenerCount(), 0);
    assert.ok(replacement.listenerCount() > 0);
    assert.equal(f.observers.filter(item => item.active).length, 1);
    assert.equal(f.controller.getPlayerAndState().player, null);
});

test('own banner and unrelated chat mutations do not schedule discovery', () => {
    const f = setup();
    f.controller.start();
    f.controller.setStatus({ state: 'waiting-ad', hasAds: true });
    const banner = f.playerContainer.querySelector('[data-vaft-status]');
    assert.ok(banner);
    const before = f.controller.getDiagnostics().metrics.scans;
    f.mutate([banner]);
    f.mutate([new Element('span')]);
    f.advance(200);
    assert.equal(f.controller.getDiagnostics().metrics.scans, before);
    assert.equal(f.timers.size, 1);
    assert.equal(f.controller.getDiagnostics().verifiedOverlayRules, 0);
    for (const state of ['searching', 'waiting-ad', 'playing', 'resuming']) {
        f.controller.setStatus({ state, hasAds: true });
        assert.equal(banner.textContent, 'Pub bloquée');
    }
    f.controller.setStatus({ state: 'error', hasAds: false });
    assert.equal(banner.textContent, 'Récupération du lecteur indisponible.');
    f.controller.setStatus({ state: 'unknown', hasAds: false });
    assert.equal(banner.style.display, 'none');
});

test('BFCache suspend releases active resources and resume attaches exactly once', () => {
    const f = setup();
    f.controller.start();
    f.win.emit('pagehide');
    assert.equal(f.controller.getDiagnostics().suspended, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.video.listenerCount(), 0);
    f.advance(5000);
    f.win.emit('pageshow');
    f.win.emit('pageshow');
    assert.equal(f.timers.size, 1);
    assert.equal(f.observers.filter(item => item.active).length, 1);
    assert.equal(f.controller.getContext().kind, 'live');
    f.controller.stop();
    assert.equal(f.win.listenerCount(), 0);
});

test('pause/play uses HTML fallback, respects the cooldown, and preserves volume/mute', () => {
    const f = setup();
    f.controller.start();
    assert.equal(f.controller.task({ pausePlay: true }), true);
    assert.equal(f.video.playCalls, 1);
    assert.equal(f.video.muted, true);
    assert.equal(f.video.volume, 0.3);
    assert.equal(f.controller.task({ pausePlay: true }), false);
    f.advance(8000);
    assert.equal(f.controller.task({ pausePlay: true }), true);
    f.video.pause();
    f.advance(8000);
    assert.equal(f.controller.task({ pausePlay: true }), false);
    assert.equal(f.video.playCalls, 2);
});

test('reload requires an unambiguous live React state and never reloads a VOD', () => {
    const f = setup();
    const { state } = f.addReact();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), true);
    assert.equal(state.calls, 1);
    assert.equal(f.controller.task({ reload: true }), false);
    f.advance(8000);
    f.win.location.href = 'https://www.twitch.tv/videos/999';
    assert.equal(f.controller.task({ reload: true }), false);
    assert.equal(state.calls, 1);
    const noReact = setup();
    noReact.controller.start();
    assert.equal(noReact.controller.task({ reload: true }), false);
});

test('React hydration on the same video recovers after a bounded negative-cache delay', () => {
    const f = setup();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), false);
    const { player, state } = f.addReact();
    for (let index = 0; index < 13; index++) {
        f.advance(600);
        assert.equal(f.controller.task({ reload: true }), false);
    }
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 1);
    assert.equal(state.calls, 0);
    f.advance(200);
    assert.equal(f.controller.task({ reload: true }), true);
    assert.equal(state.calls, 1);
    assert.equal(f.controller.getPlayerAndState().video, f.video);
    assert.equal(f.controller.getPlayerAndState().player, player);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 2);
    f.advance(16000);
    assert.equal(f.controller.getPlayerAndState().player, player);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 2, 'successful association stays cached');
});

test('negative-cache retries still refuse ambiguous React players', () => {
    const f = setup();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), false);
    const { state } = f.addReact();
    const fiber = f.root._reactRootContainer._internalRoot.current;
    fiber.sibling = { stateNode: {
        setPlayerActive() {},
        props: { mediaPlayerInstance: { getHTMLVideoElement: () => f.video } }
    } };
    f.advance(8000);
    assert.equal(f.controller.task({ reload: true }), false);
    assert.equal(f.controller.getPlayerAndState().player, null);
    assert.equal(state.calls, 0);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 2);
    delete fiber.sibling;
    f.advance(7999);
    assert.equal(f.controller.task({ reload: true }), false);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 2);
    f.advance(1);
    assert.equal(f.controller.task({ reload: true }), true);
    assert.equal(state.calls, 1);
    assert.equal(f.controller.getDiagnostics().metrics.reactScans, 3);
});

test('confirmed ad recovery can reload an initially empty paused video without forcing play', () => {
    const f = setup();
    f.video.paused = true;
    f.video.readyState = 0;
    const { state } = f.addReact();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), false, 'ordinary reload retains the pause gate');
    assert.equal(f.controller.task({ pausePlay: true, adRecovery: true }), false, 'never force pause/play during startup');
    assert.equal(f.controller.task({ reload: true, adRecovery: true }), true);
    assert.equal(state.calls, 1);
    assert.equal(f.video.playCalls, 0);
    assert.equal(f.controller.task({ reload: true, adRecovery: true }), false, 'reload cooldown still applies');
    // The player starts naturally after setSrc. Its initial HAVE_NOTHING state
    // must not become a pause to restore when metadata arrives.
    f.video.paused = false;
    f.video.readyState = 1;
    f.video.emit('loadedmetadata');
    assert.equal(f.video.paused, false);
    assert.equal(f.video.pauseCalls, 0);
    assert.equal(f.video.playCalls, 0);
});

test('ad recovery preserves loaded, uncertain, and explicitly observed pauses', () => {
    for (const readyState of [1, undefined]) {
        const f = setup();
        f.video.paused = true;
        f.video.readyState = readyState;
        const { state } = f.addReact();
        f.controller.start();
        assert.equal(f.controller.task({ reload: true, adRecovery: true }), false);
        assert.equal(state.calls, 0);
        assert.equal(f.video.playCalls, 0);
    }
    const waiting = setup();
    waiting.video.paused = true;
    waiting.video.readyState = 0;
    const { state } = waiting.addReact();
    waiting.controller.start();
    waiting.video.emit('pause');
    assert.equal(waiting.controller.task({ reload: true, adRecovery: true }), false);
    assert.equal(state.calls, 0);
    assert.equal(waiting.video.playCalls, 0);
});

test('an emptied video that already loaded media is not treated as initial buffering', () => {
    const f = setup();
    f.video.paused = true;
    f.video.readyState = 0;
    const { state } = f.addReact();
    f.controller.start();
    f.video.readyState = 1;
    f.video.emit('loadedmetadata');
    f.video.readyState = 0;
    f.video.emit('emptied');
    assert.equal(f.controller.task({ reload: true, adRecovery: true }), false);
    assert.equal(state.calls, 0);
    assert.equal(f.video.playCalls, 0);
});

test('a user pause during initial ad recovery survives replacement media', () => {
    const f = setup();
    f.video.paused = true;
    f.video.readyState = 0;
    const { state } = f.addReact();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true, adRecovery: true }), true);
    f.video.paused = false;
    f.video.pause();
    const replacement = new Video();
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    f.mutate([replacement], [f.video]);
    f.advance(150);
    assert.equal(state.calls, 1);
    assert.equal(replacement.paused, true);
    assert.equal(replacement.playCalls, 0);
});

test('a same-route replacement keeps an observed pause even without reload restore state', () => {
    for (const delayedReplacement of [false, true]) {
        const f = setup();
        f.video.readyState = 4;
        f.video.currentTime = 10;
        const { player, state } = f.addReact();
        f.controller.start();
        f.video.pause();
        const replacement = new Video();
        replacement.paused = true;
        replacement.readyState = 0;
        f.video.remove();
        if (delayedReplacement) {
            f.mutate([], [f.video]);
            f.advance(150);
        }
        f.playerContainer.appendChild(replacement);
        player.getHTMLVideoElement = () => replacement;
        f.mutate([replacement], delayedReplacement ? [] : [f.video]);
        f.advance(150);
        assert.equal(f.controller.task({ reload: true, adRecovery: true }), false);
        assert.equal(state.calls, 0);
        assert.equal(replacement.playCalls, 0);
        // An explicit subsequent play clears the retained pause intent.
        replacement.play();
        assert.equal(f.controller.task({ reload: true, adRecovery: true }), true);
        assert.equal(state.calls, 1);
    }
});

test('a new channel with new media does not inherit the previous channel pause', () => {
    const f = setup();
    f.video.readyState = 4;
    f.video.currentTime = 10;
    const { player, state } = f.addReact();
    f.controller.start();
    f.video.pause();
    const replacement = new Video();
    replacement.paused = true;
    replacement.readyState = 0;
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    player.getHTMLVideoElement = () => replacement;
    f.win.location.href = 'https://www.twitch.tv/other_channel';
    f.mutate([replacement], [f.video]);
    f.advance(150);
    assert.equal(f.controller.getContext().id, 'other_channel');
    assert.equal(f.controller.task({ reload: true, adRecovery: true }), true);
    assert.equal(state.calls, 1);
    assert.equal(replacement.playCalls, 0);
});

test('reload restores sound settings on replacement media without forcing playback', () => {
    const f = setup();
    f.addReact();
    f.controller.start();
    f.controller.task({ reload: true });
    const replacement = new Video();
    replacement.muted = false;
    replacement.volume = 1;
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    f.mutate([replacement], [f.video]);
    f.advance(150);
    assert.equal(replacement.muted, true);
    assert.equal(replacement.volume, 0.3);
    assert.equal(replacement.playCalls, 0);
});

test('an intentional pause after reload remains paused after media replacement', () => {
    const f = setup();
    f.addReact();
    f.controller.start();
    f.controller.task({ reload: true });
    f.video.pause();
    const replacement = new Video();
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    f.mutate([replacement], [f.video]);
    f.advance(150);
    assert.equal(replacement.paused, true);
    assert.equal(replacement.playCalls, 0);
});

test('a later play supersedes a pending pause restore before metadata arrives', () => {
    const f = setup();
    f.addReact();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), true);
    f.video.pause();
    f.video.play();
    f.video.emit('loadedmetadata');
    assert.equal(f.video.paused, false);
    assert.equal(f.video.pauseCalls, 1, 'restoration must not replay an outdated pause');
    assert.equal(f.video.playCalls, 1, 'only the explicit play is issued');
    f.video.emit('loadedmetadata');
    assert.equal(f.video.pauseCalls, 1, 'the restore is consumed once');
});

test('a new pause after play stays authoritative during a pending reload', () => {
    const f = setup();
    f.addReact();
    f.controller.start();
    assert.equal(f.controller.task({ reload: true }), true);
    f.video.pause();
    f.video.play();
    f.video.pause();
    const replacement = new Video();
    f.video.remove();
    f.playerContainer.appendChild(replacement);
    f.mutate([replacement], [f.video]);
    f.advance(150);
    assert.equal(replacement.paused, true);
    assert.equal(replacement.playCalls, 0);
});

test('VOD skipping stays off by default and requires reliable confirmed ranges', () => {
    const f = setup({}, '/videos/123');
    f.video.currentTime = 12;
    f.controller.start();
    assert.equal(setRanges(f), false);
    assert.equal(f.video.currentTime, 12);
    const g = setup({ vodAdSkipping: true }, '/videos/123');
    g.video.currentTime = 12;
    g.controller.start();
    assert.equal(setRanges(g, undefined, { timelineReliable: false }), false);
    setRanges(g, [{ start: 10, end: 20 }]);
    assert.equal(g.video.currentTime, 12);
    setRanges(g, [{ confirmed: true, start: 20, end: 10 }]);
    assert.equal(g.video.currentTime, 12);
});

test('VOD range epoch/id isolation rejects stale media and skips once per passage', () => {
    const f = setup({ vodAdSkipping: true }, '/videos/123');
    f.controller.start();
    f.video.currentTime = 12;
    assert.equal(setRanges(f, undefined, { epoch: 0 }), false);
    assert.equal(setRanges(f, undefined, { id: '456' }), false);
    assert.equal(f.video.currentTime, 12);
    assert.equal(setRanges(f), true);
    assert.equal(f.video.currentTime, 20);
    f.video.emit('timeupdate');
    assert.equal(f.controller.getDiagnostics().metrics.vodSkips, 1);
    f.video.currentTime = 11;
    f.video.emit('seeking');
    assert.equal(f.video.currentTime, 20);
    assert.equal(f.controller.getDiagnostics().metrics.vodSkips, 2);
});

test('VOD skip preserves intentional pause and audio settings', () => {
    const f = setup({ vodAdSkipping: true }, '/videos/123');
    f.controller.start();
    f.video.pause();
    f.video.currentTime = 12;
    setRanges(f);
    assert.equal(f.video.currentTime, 20);
    assert.equal(f.video.paused, true);
    assert.equal(f.video.playCalls, 0);
    assert.equal(f.video.muted, true);
    assert.equal(f.video.volume, 0.3);
});

test('a confirmed inaccessible range pauses explicitly then resumes only its own pause', () => {
    const f = setup({ vodAdSkipping: true }, '/videos/123');
    f.video.setSeekable([[0, 15]]);
    f.controller.start();
    f.video.currentTime = 12;
    setRanges(f);
    assert.equal(f.video.paused, true);
    assert.equal(f.video.currentTime, 12);
    assert.equal(f.controller.getDiagnostics().status.state, 'waiting-ad');
    f.video.setSeekable([[0, 30]]);
    f.advance(2000);
    assert.equal(f.video.currentTime, 20);
    assert.equal(f.video.paused, false);
    assert.equal(f.video.playCalls, 1);
});

test('VOD waiting respects a later manual seek/pause and never resumes that intent', () => {
    const f = setup({ vodAdSkipping: true }, '/videos/123');
    f.video.setSeekable([[0, 15]]);
    f.controller.start();
    f.video.currentTime = 12;
    setRanges(f);
    f.video.currentTime = 13;
    f.video.emit('seeking');
    f.video.setSeekable([[0, 30]]);
    f.advance(2000);
    assert.equal(f.video.currentTime, 20);
    assert.equal(f.video.paused, true);
    assert.equal(f.video.playCalls, 0);
});

test('twenty media changes do not grow active timer or observer/listener registries', () => {
    const f = setup();
    f.controller.start();
    let oldVideo = f.video;
    for (let index = 0; index < 20; index++) {
        const next = new Video();
        oldVideo.remove();
        f.playerContainer.appendChild(next);
        f.mutate([next], [oldVideo]);
        f.advance(150);
        assert.equal(oldVideo.listenerCount(), 0);
        assert.equal(f.timers.size, 1);
        assert.equal(f.observers.filter(item => item.active).length, 1);
        oldVideo = next;
    }
    f.controller.stop();
    assert.equal(oldVideo.listenerCount(), 0);
    assert.equal(f.timers.size, 0);
});

test('diagnostics use fixed codes without exception details and are debug-gated', () => {
    const f = setup({ debug: true });
    f.controller.start();
    f.controller.task({ reload: true });
    f.controller.task({ reload: true });
    assert.deepEqual(f.diagnostics, [{ code: 'reload-unavailable', kind: 'live', epoch: 1 }]);
    const quiet = setup();
    quiet.controller.start();
    quiet.controller.task({ reload: true });
    assert.equal(quiet.diagnostics.length, 0);
});
