'use strict';

// These are interface tests, not a substitute for Twitch/Violentmonkey playback tests.
// Run from the repository root: node --test test/vod-ads.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(repository, 'vaft.user.js'), 'utf8');
const startMarker = '    function hookVodAdRequests() {';
const endMarker = '    function onContentLoaded() {';
const start = script.indexOf(startMarker);
const end = script.indexOf(endMarker, start);
assert.ok(start !== -1 && end > start, 'The isolated VOD hook must precede onContentLoaded');
const hookSource = script.slice(start, end);
const adUrl = 'https://edge.ads.twitch.tv/2018-01-01/3p/ads';

function harness(options = {}) {
    const calls = [];
    const originalResponse = new Response('original response', { status: 202 });
    let content = options.content === undefined ? { type: 'vod', id: '12345' } : options.content;
    let containers = options.containers === undefined ? [{}] : options.containers;
    let failPlayerLookup = false;

    class NativeXHR extends EventTarget {
        constructor() {
            super();
            this.openCalls = [];
            this.headers = [];
            this.sendCalls = [];
            this.abortCalls = [];
            this.responseType = '';
            this.timeout = 0;
            this.withCredentials = false;
            this.readyState = 0;
            this.status = 0;
            this.response = null;
            this.responseText = '';
            this.failNextOpen = false;
        }
        open(...args) {
            this.openCalls.push(args);
            if (this.failNextOpen) {
                this.failNextOpen = false;
                throw new DOMException('Native open failed', 'SecurityError');
            }
            this.headers = [];
            this.url = String(args[1]);
            this.async = args.length < 3 || args[2] !== false;
            this.readyState = 1;
        }
        setRequestHeader(...args) {
            if (this.readyState !== 1) throw new DOMException('Not opened', 'InvalidStateError');
            this.headers.push(args);
        }
        send(...args) {
            if (this.readyState !== 1) throw new DOMException('Not opened', 'InvalidStateError');
            this.sendCalls.push(args);
            const complete = () => {
                if (this.readyState !== 1) return;
                const local = this.url.startsWith('data:application/json,');
                this.responseText = local ? decodeURIComponent(this.url.split(',').slice(1).join(',')) : 'original response';
                this.response = this.responseType === 'json' ? JSON.parse(this.responseText) : this.responseText;
                this.status = local ? 200 : 202;
                this.readyState = 4;
                this.dispatchEvent(new Event('readystatechange'));
                this.dispatchEvent(new Event('load'));
                this.dispatchEvent(new Event('loadend'));
            };
            if (this.async) queueMicrotask(complete);
            else complete();
        }
        abort(...args) {
            this.abortCalls.push(args);
            this.readyState = 0;
            this.status = 0;
            this.dispatchEvent(new Event('abort'));
            this.dispatchEvent(new Event('loadend'));
        }
    }
    const nativeMethods = {
        open: NativeXHR.prototype.open,
        send: NativeXHR.prototype.send,
        abort: NativeXHR.prototype.abort,
        setRequestHeader: NativeXHR.prototype.setRequestHeader,
    };
    const sandbox = {
        URL, Request, Response, Headers, AbortController, AbortSignal, DOMException,
        Promise, WeakMap, WeakSet, Map, Set, Object, Reflect, JSON,
        XMLHttpRequest: NativeXHR,
        location: new URL(options.page || 'https://www.twitch.tv/videos/12345'),
        document: {
            querySelectorAll(selector) {
                assert.equal(selector, '.video-player');
                return containers;
            },
        },
        getPlayerAndState() {
            if (failPlayerLookup) throw new Error('React state unavailable');
            return content === null ? null : { player: {}, state: { props: { content } } };
        },
        fetch: function (...args) {
            calls.push({ receiver: this, args });
            return Promise.resolve(originalResponse);
        },
    };
    sandbox.document.location = sandbox.location;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.top = options.frame ? {} : sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(`${hookSource}\nhookVodAdRequests();`, context, { timeout: 1000 });
    return {
        window: sandbox, calls, originalResponse, NativeXHR, nativeMethods,
        navigate(url) { sandbox.location.href = url; },
        setContent(value) { content = value; },
        setContainers(value) { containers = value; },
        failPlayerLookup() { failPlayerLookup = true; },
    };
}

async function expectBlocked(h, input = adUrl, init) {
    const before = h.calls.length;
    const response = await h.window.fetch(input, init);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json(?:;|$)/i);
    assert.deepEqual(await response.json(), []);
    assert.equal(h.calls.length, before, 'A matched request must not reach the previous fetch');
}

async function expectPassed(h, input = adUrl, init) {
    const before = h.calls.length;
    const receiver = {};
    const response = await h.window.fetch.call(receiver, input, init);
    assert.strictEqual(response, h.originalResponse);
    assert.equal(h.calls.length, before + 1);
    assert.strictEqual(h.calls.at(-1).receiver, receiver);
    assert.strictEqual(h.calls.at(-1).args[0], input);
    assert.strictEqual(h.calls.at(-1).args[1], init);
}

test('Only the requested script changes exist relative to main 37.0.2', () => {
    const original = execFileSync('git', ['show', '7459d9bf0a8e5170327f9e95c71302f45e26fcb1:vaft.user.js'], { cwd: repository, encoding: 'utf8' });
    const normalizeNewlines = text => text.replace(/\r\n/g, '\n');
    const oldBanner = "'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '')";
    let restored = script.slice(0, start) + script.slice(end);
    restored = normalizeNewlines(restored)
        .replace(/^    hookVodAdRequests\(\);\n/m, '')
        .replace(/^\/\/ @version\s+37\.0\.6$/m, '// @version      37.0.2')
        .replace("adBlockDiv.P.textContent = 'Pub bloquée'", `adBlockDiv.P.textContent = ${oldBanner}`);
    assert.equal(restored, normalizeNewlines(original));
    assert.equal((script.match(/    hookVodAdRequests\(\);/g) || []).length, 1);
    assert.match(script, /    hookFetch\(\);\r?\n    hookVodAdRequests\(\);/);
    assert.match(script, /adBlockDiv\.P\.textContent = 'Pub bloquée';/);
});

test('fetch accepts string, URL and Request inputs without changing their metadata', async () => {
    const h = harness();
    await expectBlocked(h);
    await expectBlocked(h, new URL(adUrl));
    const headers = new Headers({ 'X-Test': 'kept' });
    const request = new Request(`${adUrl}?session=example`, { headers });
    await expectBlocked(h, request);
    assert.equal(request.headers.get('X-Test'), 'kept');
    assert.equal(request.bodyUsed, false);
    assert.equal(request.url, `${adUrl}?session=example`);
    assert.equal(headers.get('X-Test'), 'kept');
    assert.equal(request.signal.aborted, false);
});

test('fetch permits query strings, default HTTPS port and normal GET spelling', async () => {
    const h = harness();
    await expectBlocked(h, `${adUrl}?foo=bar`);
    await expectBlocked(h, 'https://edge.ads.twitch.tv:443/2018-01-01/3p/ads');
    await expectBlocked(h, adUrl, { method: 'get' });
});

test('fetch method override takes precedence over the Request method', async () => {
    const h = harness();
    await expectPassed(h, adUrl, { method: 'POST', body: 'unchanged' });
    await expectPassed(h, new Request(adUrl, { method: 'GET' }), { method: 'POST' });
    const post = new Request(adUrl, { method: 'POST' });
    await expectPassed(h, post);
    await expectBlocked(h, post, { method: 'GET' });
    assert.equal(post.method, 'POST');
    assert.equal(post.bodyUsed, false);
});

test('fetch rejects an already aborted input signal with AbortError', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.window.fetch(adUrl, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(h.window.fetch(new Request(adUrl, { signal: controller.signal })), { name: 'AbortError' });
    assert.equal(h.calls.length, 0);
});

test('fetch signal override can cancel or override an aborted Request signal', async () => {
    const h = harness();
    const stopped = new AbortController();
    stopped.abort();
    const active = new AbortController();
    const request = new Request(adUrl, { signal: stopped.signal });
    await expectBlocked(h, request, { signal: active.signal });
    await expectBlocked(h, request, { signal: null });
    await assert.rejects(h.window.fetch(new Request(adUrl), { signal: stopped.signal }), { name: 'AbortError' });
    assert.equal(active.signal.aborted, false);
});

test('Invalid targeted GET bodies reject without touching the previous fetch', async () => {
    const h = harness();
    await assert.rejects(h.window.fetch(adUrl, { body: 'invalid GET body' }), { name: 'TypeError' });
    assert.equal(h.calls.length, 0);
});

test('A request aborted before the local response settles rejects with its reason', async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const pending = h.window.fetch(adUrl, { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(h.calls.length, 0);
});

const untouchedTargets = [
    'http://edge.ads.twitch.tv/2018-01-01/3p/ads',
    'https://edge.ads.twitch.tv:444/2018-01-01/3p/ads',
    'https://edge.ads.twitch.tv.evil.example/2018-01-01/3p/ads',
    'https://other.twitch.tv/2018-01-01/3p/ads',
    `${adUrl}/`,
    'https://edge.ads.twitch.tv/2018-01-01/3p/ads-extra',
    'https://edge.ads.twitch.tv/another/3p/ads',
    'https://user:password@edge.ads.twitch.tv/2018-01-01/3p/ads',
    'https://gql.twitch.tv/gql',
    'https://usher.ttvnw.net/vod/12345.m3u8',
    'https://video-weaver.example/video.ts',
    'https://irc-ws.chat.twitch.tv/',
    '/2018-01-01/3p/ads',
    'not a URL',
];
for (const url of untouchedTargets) {
    test(`Unrelated or nonexact request passes through: ${url}`, async () => {
        const h = harness();
        const options = Object.freeze({ headers: new Headers({ 'X-Example': 'value' }) });
        await expectPassed(h, url, options);
    });
}

test('Unrelated Request body and previous interceptor result retain their identities', async () => {
    const h = harness();
    const request = new Request('https://gql.twitch.tv/gql', { method: 'POST', body: '{"query":"unchanged"}' });
    await expectPassed(h, request);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), '{"query":"unchanged"}');
});

for (const page of [
    'https://www.twitch.tv/gotaga',
    'https://www.twitch.tv/',
    'https://www.twitch.tv/videos/',
    'https://www.twitch.tv/videos/12345/extra',
    'https://www.twitch.tv/videos/not-a-number',
    'https://player.twitch.tv/videos/12345',
    'https://www.twitch.tv.evil.example/videos/12345',
    'http://www.twitch.tv/videos/12345',
]) {
    test(`No VOD interception on page ${page}`, async () => {
        const h = harness({ page });
        await expectPassed(h);
        const xhr = new h.window.XMLHttpRequest();
        xhr.open('GET', adUrl);
        assert.equal(xhr.openCalls[0][1], adUrl);
    });
}

test('Bare Twitch domain, optional trailing slash and query parameters are supported', async () => {
    for (const page of ['https://twitch.tv/videos/12345', 'https://www.twitch.tv/videos/12345/', 'https://www.twitch.tv/videos/12345?t=1h']) {
        await expectBlocked(harness({ page }));
    }
});

test('Framed VOD pages never intercept', async () => {
    const h = harness({ frame: true });
    await expectPassed(h);
    const xhr = new h.window.XMLHttpRequest();
    xhr.open('GET', adUrl);
    assert.equal(xhr.openCalls[0][1], adUrl);
});

test('Multiple players, a residual live player and a mismatched VOD id pass through', async () => {
    for (const options of [
        { containers: [{}, {}] },
        { content: { type: 'live', id: '12345' } },
        { content: { type: 'vod', id: '67890' } },
    ]) {
        const h = harness(options);
        await expectPassed(h);
        const xhr = new h.window.XMLHttpRequest();
        xhr.open('GET', adUrl);
        assert.equal(xhr.openCalls[0][1], adUrl);
    }
});

test('Unknown early VOD player state can block without inspecting or rewriting media', async () => {
    await expectBlocked(harness({ content: null, containers: [] }));
    await expectBlocked(harness({ content: { type: 'vod' } }));
});

test('Unavailable React player lookup fails open instead of breaking fetch', async () => {
    const h = harness();
    h.failPlayerLookup();
    await expectPassed(h);
});

test('SPA transitions reevaluate URL and residual player at each request', async () => {
    const h = harness();
    await expectBlocked(h);
    h.navigate('https://www.twitch.tv/gotaga');
    h.setContent({ type: 'live' });
    await expectPassed(h);
    h.navigate('https://www.twitch.tv/videos/67890');
    await expectPassed(h);
    h.setContent({ type: 'vod', id: '12345' });
    await expectPassed(h);
    h.setContent({ type: 'vod', id: '67890' });
    await expectBlocked(h);
});

test('XHR preserves the native constructor, headers, send and abort methods', () => {
    const h = harness();
    assert.strictEqual(h.window.XMLHttpRequest, h.NativeXHR);
    assert.strictEqual(h.window.XMLHttpRequest.prototype.send, h.nativeMethods.send);
    assert.strictEqual(h.window.XMLHttpRequest.prototype.abort, h.nativeMethods.abort);
    assert.strictEqual(h.window.XMLHttpRequest.prototype.setRequestHeader, h.nativeMethods.setRequestHeader);
    const xhr = new h.window.XMLHttpRequest();
    assert.ok(xhr instanceof h.NativeXHR);
});

test('XHR changes only the exact GET URL and preserves open arguments', () => {
    const h = harness();
    const xhr = new h.window.XMLHttpRequest();
    xhr.open('GET', adUrl, false, 'username', 'password');
    assert.deepEqual(xhr.openCalls[0], ['GET', 'data:application/json,%5B%5D', false, 'username', 'password']);
    const body = { unusedGetBody: true };
    xhr.send(body);
    assert.strictEqual(xhr.sendCalls[0][0], body);
    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseText, '[]');
});

test('XHR delegates events, JSON response type and properties to the native stand-in', async () => {
    const h = harness();
    const xhr = new h.window.XMLHttpRequest();
    const events = [];
    for (const name of ['readystatechange', 'load', 'loadend']) xhr.addEventListener(name, () => events.push(name));
    xhr.open('GET', new URL(adUrl), true);
    xhr.responseType = 'json';
    xhr.timeout = 7000;
    xhr.withCredentials = true;
    xhr.setRequestHeader('Authorization', 'example value');
    xhr.send();
    assert.equal(xhr.readyState, 1);
    assert.deepEqual(events, []);
    await Promise.resolve();
    assert.equal(xhr.status, 200);
    assert.deepEqual(xhr.response, []);
    assert.deepEqual(events, ['readystatechange', 'load', 'loadend']);
    assert.equal(xhr.timeout, 7000);
    assert.equal(xhr.withCredentials, true);
    assert.deepEqual(xhr.headers, [['Authorization', 'example value']]);
});

test('XHR abort remains native and prevents pending local load events', async () => {
    const h = harness();
    const xhr = new h.window.XMLHttpRequest();
    const events = [];
    for (const name of ['abort', 'load', 'loadend']) xhr.addEventListener(name, () => events.push(name));
    xhr.open('GET', adUrl);
    xhr.send();
    xhr.abort();
    await Promise.resolve();
    assert.equal(xhr.abortCalls.length, 1);
    assert.equal(xhr.readyState, 0);
    assert.deepEqual(events, ['abort', 'loadend']);
});

test('XHR reevaluates every open and preserves native headers for all requests', () => {
    const h = harness();
    const xhr = new h.window.XMLHttpRequest();
    xhr.open('GET', adUrl);
    xhr.setRequestHeader('X-Blocked', 'one');
    assert.deepEqual(xhr.headers, [['X-Blocked', 'one']]);
    xhr.open('GET', 'https://example.com/video');
    xhr.setRequestHeader('X-Normal', 'two');
    assert.deepEqual(xhr.headers, [['X-Normal', 'two']]);
    xhr.open('GET', adUrl);
    xhr.setRequestHeader('X-Blocked', 'three');
    assert.deepEqual(xhr.headers, [['X-Blocked', 'three']]);
    xhr.open('POST', adUrl);
    xhr.setRequestHeader('X-Post', 'four');
    assert.deepEqual(xhr.headers, [['X-Post', 'four']]);
    assert.equal(xhr.openCalls.at(-1)[1], adUrl);
});

test('XHR instances keep their independent native header state', () => {
    const h = harness();
    const targeted = new h.window.XMLHttpRequest();
    const normal = new h.window.XMLHttpRequest();
    targeted.open('GET', adUrl);
    normal.open('GET', 'https://example.com/');
    targeted.setRequestHeader('X-Example', 'first');
    normal.setRequestHeader('X-Example', 'second');
    assert.deepEqual(targeted.headers, [['X-Example', 'first']]);
    assert.deepEqual(normal.headers, [['X-Example', 'second']]);
});

test('XHR native open failures propagate without replacing native header behavior', () => {
    const h = harness();
    const xhr = new h.window.XMLHttpRequest();
    xhr.open('GET', adUrl);
    xhr.failNextOpen = true;
    assert.throws(() => xhr.open('GET', adUrl), { name: 'SecurityError' });
    // The stand-in retains OPENED on failure; native header behavior stays intact.
    xhr.setRequestHeader('X-After-Failure', 'value');
    assert.deepEqual(xhr.headers, [['X-After-Failure', 'value']]);
});

test('XHR method and URL pass through unchanged for every untargeted request', () => {
    const h = harness();
    for (const url of untouchedTargets) {
        const xhr = new h.window.XMLHttpRequest();
        const input = url.startsWith('https:') ? new URL(url) : url;
        xhr.open('GET', input, true);
        assert.strictEqual(xhr.openCalls[0][1], input);
        xhr.setRequestHeader('X-Original', 'kept');
        assert.deepEqual(xhr.headers, [['X-Original', 'kept']]);
    }
});
