'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createVaftRuntime, workerBootstrap } = require('../src/runtime.js');
const { createNetworkTools } = require('../src/network.js');
const { createHlsTools } = require('../src/hls.js');
const { config } = require('../src/config.js');

const endpoint = 'https://gql.twitch.tv/gql';
const protocol = 'vaft-matteo:1';
const flush = () => new Promise(resolve => setImmediate(resolve));
const tokenResponse = () => new Response(JSON.stringify({ data: {
    streamPlaybackAccessToken: { value: 'fixture-value', signature: 'fixture-signature' }
} }));

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, data = {}) {
        for (const callback of [...(this.listeners.get(type) || [])]) callback({ type, target: this, ...data });
    }
    listenerCount() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}

// Source of this factory is embedded in a real vm context by the runtime under test.
function workerEngineFixture(scope) {
    return {
        start() { scope.trace.push('vaft-start'); },
        refreshFetch() { scope.trace.push('vaft-refresh'); }
    };
}

function installNoSubFixture(window) {
    const oldWorker = window.Worker;
    // Same constructor chaining and replaceAll constraint as TwitchNoSub 1.2.1.
    window.Worker = class NoSubWorker extends oldWorker {
        constructor(url) {
            const request = new window.XMLHttpRequest();
            request.open('GET', url.replaceAll("'", '%27'), false);
            request.send();
            const patched = window.URL.createObjectURL(new window.Blob([
                "self.trace.push('tns-patch');\n", request.responseText
            ]));
            super(patched);
            this.noSubFixture = true;
        }
    };
}

function setup(t, options = {}) {
    const blobs = new Map();
    const revoked = [];
    const xhrCalls = [];
    const timers = new Set();
    const fetchCalls = [];
    const nativeWorkers = [];
    const statuses = [];
    const tasks = [];
    const ranges = [];
    let blobSerial = 0;
    let playerContext = { kind: 'live', id: 'example', epoch: 1 };
    let playerCallbacks;
    class MemoryBlob {
        constructor(parts, settings) { this.source = parts.join(''); this.type = settings?.type || ''; }
    }
    class MemoryURL extends URL {
        static createObjectURL(blob) {
            const url = `blob:https://www.twitch.tv/fixture-${++blobSerial}`;
            blobs.set(url, blob.source);
            return url;
        }
        static revokeObjectURL(url) { revoked.push(url); blobs.delete(url); }
    }
    class MemoryXHR {
        open(method, url, async) { this.url = url; xhrCalls.push({ method, url, async }); }
        overrideMimeType() {}
        send() {
            if (!blobs.has(this.url)) throw new Error('Revoked fixture Blob URL');
            this.responseText = blobs.get(this.url);
            this.status = 200;
        }
    }
    class NativeWorker extends Events {
        constructor(...args) {
            super();
            this.args = args;
            this.source = blobs.get(String(args[0]));
            this.posted = [];
            this.terminated = false;
            nativeWorkers.push(this);
        }
        postMessage(message) { this.posted.push(message); }
        terminate(...args) { this.terminated = true; this.terminateArguments = args; }
        run() {
            assert.equal(typeof this.source, 'string', 'Native worker captured its entry script during construction');
            const scope = { trace: [], URL: MemoryURL, Request, Response, Headers, AbortController,
                DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout };
            scope.self = scope;
            scope.postMessage = data => this.emit('message', { data });
            const context = vm.createContext(scope);
            scope.importScripts = url => {
                if (!blobs.has(url)) throw new Error('Revoked imported Blob URL');
                vm.runInContext(blobs.get(url), context);
            };
            vm.runInContext(this.source, context);
            this.scope = scope;
            return scope;
        }
    }
    const window = new Events();
    Object.assign(window, { URL: MemoryURL, Worker: NativeWorker, Blob: MemoryBlob,
        XMLHttpRequest: MemoryXHR, Request, Response, Headers, AbortController, DOMException,
        TextEncoder, TextDecoder, location: { href: 'https://www.twitch.tv/example' }, console: { info() {} },
        setTimeout(fn, delay) {
            const id = setTimeout(() => { timers.delete(id); fn(); }, delay);
            timers.add(id);
            return id;
        },
        clearTimeout(id) { timers.delete(id); clearTimeout(id); },
        async fetch(input, init) {
            fetchCalls.push({ input, init });
            return options.fetch ? options.fetch(input, init) : tokenResponse();
        }
    });
    if (options.noSub === 'before') installNoSubFixture(window);
    const createPlayer = (env, settings, callbacks) => {
        playerCallbacks = callbacks;
        return {
            start() {}, stop() {}, getContext() { return { ...playerContext }; },
            setStatus(status) { statuses.push(status); },
            task(task) { tasks.push(task); },
            setVodRanges(value) { ranges.push(value); },
            getDiagnostics() { return {}; }
        };
    };
    const originalFetch = window.fetch;
    const runtime = createVaftRuntime({ window }, { ...config, ...options.config },
        createNetworkTools, createHlsTools, createPlayer, workerEngineFixture, workerBootstrap);
    runtime.start();
    if (options.noSub === 'after') installNoSubFixture(window);
    t.after(() => {
        runtime.stop();
        for (const timer of timers) clearTimeout(timer);
    });
    function createWorker(input) {
        const url = input || window.URL.createObjectURL(new window.Blob(["self.trace.push('twitch-worker');"]));
        return { worker: new window.Worker(url), url };
    }
    function send(worker, message) {
        worker.emit('message', { data: { namespace: protocol, workerId: nativeWorkers.indexOf(worker) + 1,
            epoch: playerContext.epoch, ...message } });
    }
    return { window, runtime, blobs, revoked, timers, fetchCalls, xhrCalls, nativeWorkers, statuses, tasks, ranges,
        originalFetch, createWorker, send,
        changeContext(next) { playerContext = { ...next }; playerCallbacks.onContextChange(playerContext); } };
}

test('unavailable Blob snapshot leaves native construction usable and reports initialization failure', t => {
    const f = setup(t);
    const url = f.window.URL.createObjectURL(new f.window.Blob(["self.trace.push('twitch-worker');"]));
    f.window.XMLHttpRequest = class { open() { throw new Error('fixture XHR restriction'); } };
    const options = { name: 'preserved' };
    const worker = new f.window.Worker(url, options);
    assert.equal(worker.args[0], url);
    assert.equal(worker.args[1], options);
    assert.equal(f.runtime.getDiagnostics().workers, 0);
    assert.equal(f.runtime.getDiagnostics().events['worker-startup-error'], 1);
});

test('non-Twitch and module Worker arguments are preserved without bootstrap interception', t => {
    const h = setup(t);
    const options = { type: 'module', name: 'fixture-worker', credentials: 'omit' };
    const input = new h.window.URL('https://www.twitch.tv/fixture-module.js');
    const moduleWorker = new h.window.Worker(input, options);
    assert.equal(moduleWorker.args[0], input);
    assert.equal(moduleWorker.args[1], options);
    const thirdParty = new h.window.Worker('https://example.invalid/worker.js', { name: 'unrelated' });
    assert.equal(thirdParty.args[0], 'https://example.invalid/worker.js');
    assert.equal(h.runtime.getDiagnostics().workers, 0);
    assert.equal(h.xhrCalls.length, 0);
    assert.equal(h.runtime.getDiagnostics().events['module-worker-unsupported'], 1);
});

test('classic Worker preserves constructor options and snapshots caller Blob before immediate revocation', t => {
    const h = setup(t);
    const original = h.window.URL.createObjectURL(new h.window.Blob(["self.trace.push('original-after-revoke');"]));
    const options = Object.freeze({ name: 'fixture-classic', credentials: 'same-origin' });
    const worker = new h.window.Worker(new h.window.URL(original), options);
    assert.equal(worker.args[1], options);
    assert.equal(h.runtime.getDiagnostics().blobURLs, 2);
    h.window.URL.revokeObjectURL(original);
    assert.deepEqual(worker.run().trace, ['vaft-start', 'original-after-revoke', 'vaft-refresh']);
    assert.equal(h.runtime.getDiagnostics().blobURLs, 0);
    assert.equal(h.blobs.size, 0);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.xhrCalls, [{ method: 'GET', url: original, async: false }]);
});

for (const order of ['before', 'after']) {
    test(`TwitchNoSub-like wrapper remains in the Worker chain when installed ${order} VAFT`, t => {
        const h = setup(t, { noSub: order });
        const original = h.window.URL.createObjectURL(new h.window.Blob(["self.trace.push('twitch-worker');"]));
        const worker = new h.window.Worker(new h.window.URL(original));
        h.window.URL.revokeObjectURL(original);
        const trace = worker.run().trace;
        assert.equal(worker.noSubFixture, true);
        assert.deepEqual(trace, order === 'before'
            ? ['tns-patch', 'vaft-start', 'twitch-worker', 'vaft-refresh']
            : ['vaft-start', 'tns-patch', 'twitch-worker', 'vaft-refresh']);
        assert.equal(h.runtime.getDiagnostics().workers, 1);
        assert.equal(h.runtime.getDiagnostics().blobURLs, 0);
        assert.equal(h.timers.size, 0);
        h.runtime.stop();
        assert.equal(worker.terminated, false, 'VAFT must not terminate a third-party Worker');
        assert.equal(worker.posted.at(-1).type, 'shutdown');
        assert.equal(worker.listenerCount(), 0);
        assert.equal(h.window.listenerCount(), 0);
    });
}

test('slower old GQL request cannot restore obsolete authorization after a newer anonymous request', async t => {
    const h = setup(t);
    const { worker } = h.createWorker();
    worker.run();
    let streamController;
    const body = new ReadableStream({ start(controller) { streamController = controller; } });
    const oldRequest = new Request(endpoint, { method: 'POST', body, duplex: 'half',
        headers: { Authorization: 'fixture-old-session' } });
    const pending = h.window.fetch(oldRequest);
    await h.window.fetch(endpoint, { method: 'POST', body: '{"operationName":"NewAnonymousQuery"}',
        headers: { 'Client-ID': 'fixture-client' } });
    streamController.enqueue(new TextEncoder().encode('{"operationName":"OldQuery"}'));
    streamController.close();
    await pending;
    h.send(worker, { type: 'token', id: 1, channel: 'example', playerType: 'embed' });
    await flush();
    const relay = h.fetchCalls.at(-1);
    assert.equal(relay.init.headers.get('Authorization'), null);
    assert.equal(relay.init.headers.get('Client-ID'), 'fixture-client');
    assert.equal(worker.posted.at(-1).type, 'token-result');
});

test('bridge ignores foreign, stale and invalid requests and only constructs its fixed GraphQL operation', async t => {
    const h = setup(t);
    const { worker } = h.createWorker();
    worker.run();
    for (const override of [
        { namespace: 'unrelated' }, { workerId: 999 }, { epoch: 0 }, { id: -1 },
        { channel: 'other-channel' }, { playerType: 'unknown-player' }
    ]) h.send(worker, { type: 'token', id: 1, channel: 'example', playerType: 'embed', ...override });
    await flush();
    assert.equal(h.fetchCalls.length, 0);
    h.send(worker, { type: 'token', id: 2, channel: 'example', playerType: 'embed',
        url: 'https://example.invalid/do-not-contact', headers: { Authorization: 'do-not-copy' }, body: 'do-not-copy' });
    await flush();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.fetchCalls[0].input, endpoint);
    const operation = JSON.parse(h.fetchCalls[0].init.body);
    assert.equal(operation.operationName, 'PlaybackAccessToken');
    assert.equal(operation.variables.login, 'example');
    assert.equal(operation.variables.isVod, false);
    assert.equal(h.fetchCalls[0].init.headers.get('Authorization'), null);
    assert.equal(worker.posted.at(-1).id, 2);
});

test('only a current live Worker can request recovery of an unstarted player', t => {
    const h = setup(t);
    const { worker } = h.createWorker();
    worker.run();
    for (const override of [{ namespace: 'unrelated' }, { workerId: 999 }, { epoch: 0 }]) {
        h.send(worker, { type: 'reload', ...override });
    }
    assert.deepEqual(h.tasks, []);
    h.send(worker, { type: 'reload' });
    assert.deepEqual(h.tasks, [{ reload: true, adRecovery: true }]);
    h.changeContext({ kind: 'vod', id: '123', epoch: 2 });
    h.send(worker, { type: 'reload' });
    assert.equal(h.tasks.length, 1, 'VOD must not inherit live ad recovery');
});

test('context change cancels outstanding relay and discards its late response', async t => {
    let complete;
    let requestSignal;
    const h = setup(t, { fetch: (input, init) => {
        requestSignal = init.signal;
        return new Promise(resolve => { complete = resolve; });
    } });
    const { worker } = h.createWorker();
    worker.run();
    h.send(worker, { type: 'token', id: 1, channel: 'example', playerType: 'embed' });
    assert.equal(h.runtime.getDiagnostics().requests, 1);
    h.changeContext({ kind: 'live', id: 'newchannel', epoch: 2 });
    assert.equal(requestSignal.aborted, true);
    assert.equal(h.runtime.getDiagnostics().requests, 0);
    complete(tokenResponse());
    await flush();
    assert.equal(worker.posted.filter(message => message.type === 'token-result').length, 0);
    assert.equal(worker.posted.at(-1).context.id, 'newchannel');
    assert.equal(h.timers.size, 0);
});

test('duplicate relay IDs are ignored and outstanding requests are capped', async t => {
    const h = setup(t, { fetch: () => new Promise(() => {}) });
    const { worker } = h.createWorker();
    worker.run();
    for (const id of [1, 1, 2, 3, 4]) h.send(worker, { type: 'token', id, channel: 'example', playerType: 'embed' });
    assert.equal(h.fetchCalls.length, 3);
    assert.equal(h.runtime.getDiagnostics().requests, 3);
    h.runtime.stop();
    await flush();
    assert.equal(h.runtime.getDiagnostics().requests, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(worker.terminated, false);
});

test('explicit Worker termination releases aliases, listeners and startup deadline', t => {
    const h = setup(t);
    const { worker, url } = h.createWorker();
    worker.terminate('fixture-argument');
    assert.equal(worker.terminated, true);
    assert.deepEqual(worker.terminateArguments, ['fixture-argument']);
    assert.equal(h.runtime.getDiagnostics().workers, 0);
    assert.equal(h.runtime.getDiagnostics().blobURLs, 0);
    assert.equal(worker.listenerCount(), 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.blobs.has(url), true, 'the caller still owns its original Blob');
});

test('startup deadline sends shutdown and releases own resources without terminating Worker', async t => {
    const h = setup(t, { config: { requestTimeoutMs: 20 } });
    const { worker } = h.createWorker();
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(worker.posted.at(-1).type, 'shutdown');
    assert.equal(worker.terminated, false);
    assert.equal(worker.listenerCount(), 0);
    assert.equal(h.runtime.getDiagnostics().workers, 0);
    assert.equal(h.runtime.getDiagnostics().blobURLs, 0);
    assert.equal(h.timers.size, 0);
});

test('Worker errors shut down the engine and stop restores page fetch and debug resources', t => {
    const h = setup(t, { config: { debug: true } });
    const { worker } = h.createWorker();
    worker.run();
    worker.emit('error');
    assert.equal(worker.posted.at(-1).type, 'shutdown');
    assert.equal(h.runtime.getDiagnostics().workers, 0);
    assert.equal(worker.listenerCount(), 0);
    h.runtime.stop();
    assert.equal(h.window.fetch, h.originalFetch);
    assert.equal('__VAFT_MATTEO_DEBUG__' in h.window, false);
    assert.equal(h.window.listenerCount(), 0);
    assert.equal(worker.terminated, false);
});
