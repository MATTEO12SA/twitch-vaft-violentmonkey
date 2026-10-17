'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const vm = require('node:vm');
const { createNetworkTools } = require('../src/network.js');

const network = createNetworkTools();
const endpoint = 'https://gql.twitch.tv/gql';
const live = playerType => ({
    operationName: 'PlaybackAccessToken',
    variables: { isLive: true, isVod: false, login: 'fixture-channel', playerType }
});
const vod = { operationName: 'PlaybackAccessToken', variables: { isLive: false, isVod: true, vodID: '123', playerType: 'site' } };

test('factory runs after serialization without module closure dependencies', async () => {
    const environment = { URL, Request, Response, Headers, AbortController, DOMException, TextDecoder, setTimeout, clearTimeout };
    const isolated = vm.runInNewContext(`(${createNetworkTools.toString()})(globalThis)`, environment);
    const rewritten = await isolated.rewritePlaybackRequest(endpoint, { body: JSON.stringify(live('site')) }, 'popout');
    assert.equal(JSON.parse(rewritten.init.body).variables.playerType, 'popout');
});

test('readFetchURL recognizes supported inputs and relative playlist query strings', () => {
    assert.equal(network.readFetchURL('/video.m3u8?x=1', 'https://example.test/base').pathname, '/video.m3u8');
    assert.equal(network.readFetchURL(new URL(endpoint)).href, endpoint);
    assert.equal(network.readFetchURL(new Request(endpoint)).href, endpoint);
    assert.equal(network.readFetchURL('not an absolute URL'), null);
    assert.equal(network.readFetchURL({ url: endpoint }), null);
});

test('non-target endpoints are passed through without reading headers or bodies', async () => {
    for (const url of ['https://example.test/gql', 'http://gql.twitch.tv/gql', `${endpoint}/`, `${endpoint}?x=1`]) {
        const init = { get headers() { throw new Error('must not read'); }, get body() { throw new Error('must not read'); } };
        const result = await network.rewritePlaybackRequest(url, init, 'popout');
        assert.equal(result.input, url);
        assert.equal(result.init, init);
        assert.equal(result.headers, null);
        assert.deepEqual(result.operations, []);
    }
});

test('only explicit live PlaybackAccessToken operations in mixed batches are rewritten', async () => {
    const unrelated = { operationName: 'ChatMessages', variables: { isLive: true, isVod: false, playerType: 'site' } };
    const unknown = { operationName: 'PlaybackAccessToken', variables: { isLive: true, playerType: 'site' } };
    const batch = [live('picture-by-picture'), vod, unrelated, unknown, null];
    const init = Object.freeze({ headers: Object.freeze({ 'Client-ID': 'fixture-client' }), body: JSON.stringify(batch) });
    const result = await network.rewritePlaybackRequest(endpoint, init, 'popout');
    const rewritten = JSON.parse(result.init.body);
    assert.equal(rewritten[0].variables.playerType, 'popout');
    assert.deepEqual(rewritten.slice(1), batch.slice(1));
    assert.deepEqual(JSON.parse(init.body), batch);
    assert.deepEqual(result.operations, batch);
    assert.notEqual(result.init, init);
    assert.equal(result.headers.get('Client-ID'), 'fixture-client');
});

test('Request body is read from a clone and Request options survive the body override', async () => {
    const controller = new AbortController();
    const request = new Request(endpoint, {
        method: 'POST', body: JSON.stringify(live('site')),
        headers: { 'Client-ID': 'original-client' }, signal: controller.signal,
        credentials: 'include', mode: 'cors', cache: 'no-store'
    });
    const result = await network.rewritePlaybackRequest(request, undefined, 'popout');
    assert.equal(result.input, request);
    assert.equal(request.bodyUsed, false);
    assert.equal(result.headers.get('Client-ID'), 'original-client');
    const effective = new Request(result.input, result.init);
    assert.equal(effective.method, 'POST');
    assert.equal(effective.credentials, 'include');
    assert.equal(effective.mode, 'cors');
    assert.equal(effective.cache, 'no-store');
    assert.equal(effective.headers.get('Client-ID'), 'original-client');
    assert.equal(JSON.parse(await effective.text()).variables.playerType, 'popout');
    controller.abort();
    assert.equal(effective.signal.aborted, true);
    assert.equal(JSON.parse(await request.text()).variables.playerType, 'site');
});

test('init Headers and body replace Request values without mutating either input', async () => {
    const request = new Request(endpoint, { method: 'POST', headers: { 'Client-ID': 'old' }, body: JSON.stringify(vod) });
    const headers = new Headers({ 'X-Device-Id': 'fixture-device' });
    const controller = new AbortController();
    const init = Object.freeze({ headers, body: JSON.stringify(live('site')), signal: controller.signal });
    const result = await network.rewritePlaybackRequest(request, init, 'popout');
    assert.equal(result.init.signal, controller.signal);
    assert.equal(result.headers.get('Client-ID'), null);
    assert.equal(result.headers.get('X-Device-Id'), 'fixture-device');
    result.headers.set('Client-ID', 'does-not-mutate');
    assert.equal(headers.get('Client-ID'), null);
    assert.equal(request.headers.get('Client-ID'), 'old');
    assert.deepEqual(JSON.parse(await request.text()), vod);
});

test('malformed JSON, VOD and unknown requests retain exact original arguments', async () => {
    for (const body of ['{broken', JSON.stringify(vod), 'null', '123', JSON.stringify({ variables: { playerType: 'site' } })]) {
        const init = { body };
        const result = await network.rewritePlaybackRequest(endpoint, init, 'popout');
        assert.equal(result.input, endpoint);
        assert.equal(result.init, init);
    }
});

test('unused and already consumed Request bodies pass through safely', async () => {
    assert.equal((await network.rewritePlaybackRequest(endpoint, undefined, 'popout')).init, undefined);
    const request = new Request(endpoint, { method: 'POST', body: JSON.stringify(live('site')) });
    await request.text();
    assert.equal((await network.rewritePlaybackRequest(request, undefined, 'popout')).init, undefined);
});

test('aborting a streamed Request inspection releases listeners and leaves original body intact', async () => {
    let streamController;
    const body = new ReadableStream({ start(controller) { streamController = controller; } });
    const controller = new AbortController();
    const request = new Request(endpoint, { method: 'POST', body, duplex: 'half', signal: controller.signal });
    const pending = network.rewritePlaybackRequest(request, undefined, 'popout');
    controller.abort();
    const result = await pending;
    assert.equal(result.init, undefined);
    assert.equal(request.bodyUsed, false);
    assert.deepEqual(getEventListeners(request.signal, 'abort'), []);
    const text = JSON.stringify(live('site'));
    streamController.enqueue(new TextEncoder().encode(text));
    streamController.close();
    assert.equal(await request.text(), text);
});

test('oversized Request bodies are passed through without consuming the original', async () => {
    const body = JSON.stringify({ ...live('site'), fixturePadding: 'x'.repeat(1024 * 1024) });
    const request = new Request(endpoint, { method: 'POST', body });
    const result = await network.rewritePlaybackRequest(request, undefined, 'popout');
    assert.equal(result.init, undefined);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), body);
});

test('requestText times out a fetch that never resolves and aborts its private signal', async () => {
    let internalSignal;
    await assert.rejects(network.requestText((input, init) => {
        internalSignal = init.signal;
        return new Promise(() => {});
    }, endpoint, {}, 20), { name: 'TimeoutError' });
    assert.equal(internalSignal.aborted, true);
});

test('requestText deadline includes a body which hangs after headers', async () => {
    let bodyRequested = false;
    await assert.rejects(network.requestText(async () => ({
        text() { bodyRequested = true; return new Promise(() => {}); }
    }), endpoint, {}, 20), { name: 'TimeoutError' });
    assert.equal(bodyRequested, true);
});

test('requestText caps streamed bytes, cancels without awaiting tee cancellation and cleans up', async () => {
    const timers = new Set();
    const env = Object.create(globalThis);
    env.setTimeout = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
    env.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
    const controlled = createNetworkTools(env);
    const controller = new AbortController();
    let cancelled = false;
    let internalSignal;
    const response = new Response(new ReadableStream({
        start(stream) {
            stream.enqueue(new TextEncoder().encode('ééé'));
        },
        cancel() {
            cancelled = true;
            return new Promise(() => {});
        }
    }));
    await assert.rejects(controlled.requestText(async (input, init) => {
        internalSignal = init.signal;
        return response;
    }, endpoint, { signal: controller.signal }, 1000, 5), /exceeds byte limit/);
    assert.equal(cancelled, true);
    assert.equal(internalSignal.aborted, true);
    assert.equal(response.body.locked, false);
    assert.equal(timers.size, 0);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('requestText default bound is 1 MiB and an explicit larger limit is supported', async () => {
    const text = 'x'.repeat(1024 * 1024 + 1);
    await assert.rejects(network.requestText(async () => new Response(text), endpoint), /exceeds byte limit/);
    const result = await network.requestText(async () => new Response(text), endpoint, {}, 1000, text.length);
    assert.equal(result.text.length, text.length);
});

test('requestText decodes UTF-8 split across chunks and accepts exactly maxBytes', async () => {
    const bytes = new TextEncoder().encode('é');
    const response = new Response(new ReadableStream({
        start(stream) {
            stream.enqueue(bytes.slice(0, 1));
            stream.enqueue(bytes.slice(1));
            stream.close();
        }
    }));
    const result = await network.requestText(async () => response, endpoint, {}, 1000, 2);
    assert.equal(result.text, 'é');
    assert.equal(response.body.locked, false);
});

test('requestText timeout cancels a real body reader waiting for more bytes', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await assert.rejects(network.requestText(async () => response, endpoint, {}, 20), { name: 'TimeoutError' });
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
});

test('requestText propagates caller abort reason and removes the abort listener', async () => {
    const controller = new AbortController();
    const init = Object.freeze({ signal: controller.signal, headers: { Test: 'fixture' } });
    let innerSignal;
    const pending = network.requestText((input, options) => {
        innerSignal = options.signal;
        return new Promise(() => {});
    }, endpoint, init, 1000);
    const reason = new Error('fixture cancellation');
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(innerSignal.aborted, true);
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('already aborted Request does not invoke fetch and its signal is inherited', async () => {
    const controller = new AbortController();
    const request = new Request(endpoint, { signal: controller.signal });
    controller.abort();
    let called = false;
    await assert.rejects(network.requestText(() => { called = true; }, request), { name: 'AbortError' });
    assert.equal(called, false);
});

test('init signal replaces the Request signal, matching fetch precedence', async () => {
    const controller = new AbortController();
    const request = new Request(endpoint, { signal: controller.signal });
    controller.abort();
    let called = false;
    const result = await network.requestText(async () => { called = true; return new Response('fixture'); }, request, { signal: null });
    assert.equal(called, true);
    assert.equal(result.text, 'fixture');
});

test('requestText success and body failure clear timers and caller listeners', async () => {
    const timers = new Set();
    const env = Object.create(globalThis);
    env.setTimeout = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
    env.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
    const controlled = createNetworkTools(env);
    const controller = new AbortController();
    const response = new Response('fixture playlist', { status: 202 });
    const result = await controlled.requestText(async () => response, endpoint, { signal: controller.signal });
    assert.equal(result.response, response);
    assert.equal(result.text, 'fixture playlist');
    assert.equal(timers.size, 0);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
    const bodyError = new Error('failed body');
    await assert.rejects(controlled.requestText(async () => ({ text: async () => { throw bodyError; } }), endpoint,
        { signal: controller.signal }), error => error === bodyError);
    assert.equal(timers.size, 0);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('unchanged response preserves identity and unconsumed body', async () => {
    const response = new Response('#EXTM3U', { headers: { 'Content-Length': '7' } });
    const original = await response.clone().text();
    assert.equal(network.replaceResponseText(response, original, original), response);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), '#EXTM3U');
});

test('rewritten response preserves status and useful headers but discards stale body metadata', async () => {
    const response = new Response('original', {
        status: 202, statusText: 'Fixture Accepted', headers: {
            'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store',
            'Content-Length': '8', 'Content-Encoding': 'gzip', ETag: '"fixture-old"',
            'Content-MD5': 'fixture-hash', Vary: 'Accept'
        }
    });
    const rewritten = network.replaceResponseText(response, 'original', 'updated playlist');
    assert.equal(rewritten.status, 202);
    assert.equal(rewritten.statusText, 'Fixture Accepted');
    assert.equal(rewritten.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(rewritten.headers.get('cache-control'), 'no-store');
    assert.equal(rewritten.headers.get('vary'), 'Accept');
    for (const header of ['content-length', 'content-encoding', 'etag', 'content-md5']) {
        assert.equal(rewritten.headers.get(header), null);
    }
    assert.equal(await rewritten.text(), 'updated playlist');
    assert.equal(response.headers.get('content-length'), '8');
    assert.equal(response.bodyUsed, false);
});

test('bodyless responses remain valid when a caller attempts an invalid rewrite', () => {
    for (const status of [204, 205, 304]) {
        const response = new Response(null, { status });
        assert.equal(network.replaceResponseText(response, '', 'replacement'), response);
    }
});

test('rewritten responses and repeated clones preserve fetch URL and response metadata', async () => {
    const response = new Response('#EXTM3U\nsegment.ts\n');
    // Synthetic fetch metadata: production native responses expose these prototype getters.
    Object.defineProperties(response, {
        url: { value: 'https://video.example.invalid/channel/index.m3u8?fixture=1' },
        redirected: { value: true },
        type: { value: 'cors' }
    });
    const rewritten = network.replaceResponseText(response, '#EXTM3U\nsegment.ts\n', '#EXTM3U\nclean.ts\n');
    const clone = rewritten.clone();
    const secondClone = clone.clone();
    for (const item of [rewritten, clone, secondClone]) {
        assert.equal(item.url, response.url);
        assert.equal(item.redirected, true);
        assert.equal(item.type, 'cors');
        assert.equal(new URL('clean.ts', item.url).href, 'https://video.example.invalid/channel/clean.ts');
        assert.throws(() => { item.url = 'https://example.invalid/override'; }, TypeError);
        assert.equal(await item.text(), '#EXTM3U\nclean.ts\n');
        assert.throws(() => item.clone(), TypeError, 'native clone must still reject a consumed body');
    }
    assert.equal(response.bodyUsed, false);
});
