'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(require.resolve('playwright', {
    paths: [process.env.VAFT_TEST_NODE_MODULES || process.cwd()]
}));
const { source, addonSource, makeAdUrl } = require('./helpers.cjs');
const installedWindowsBrowsers = [
    ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
].filter(([, executable]) => fs.existsSync(executable));
const browsers = process.env.VAFT_TEST_EXECUTABLE
    ? [['Selected browser', process.env.VAFT_TEST_EXECUTABLE]]
    : installedWindowsBrowsers.length ? installedWindowsBrowsers : [['Chromium', undefined]];

for (const [name, executablePath] of browsers) {
    test(`${name}: integrated userscript with isolated native XHR`, { timeout: 60000 }, async t => {
        const browser = await chromium.launch({ executablePath, headless: true });
        t.after(() => browser.close());
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const networkRequests = [];
        // Every HTTP(S) request is fulfilled here: no Twitch/ad server is contacted.
        await context.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (request.isNavigationRequest()) {
                const policy = url.searchParams.get('policy');
                const headers = policy === 'deny'
                    ? { 'Content-Security-Policy': "connect-src 'self'" }
                    : policy === 'allow'
                        ? { 'Content-Security-Policy': "connect-src 'self' data:" } : {};
                await route.fulfill({ status: 200, contentType: 'text/html', headers,
                    body: '<!doctype html><title>Isolated VOD fixture</title>' });
                return;
            }
            networkRequests.push(url.origin + url.pathname);
            await route.fulfill({ status: 200, contentType: 'application/xml', headers: {
                'Access-Control-Allow-Origin': 'https://www.twitch.tv',
                'Access-Control-Allow-Credentials': 'true'
            }, body: '<VAST version="3.0"><Ad id="fictional-test-ad"/></VAST>' });
        });
        await context.addInitScript({ content: source });
        const page = await context.newPage();
        await page.goto('https://www.twitch.tv/videos/123456789');

        async function request(options = {}) {
            return page.evaluate(async ({ url, method = 'GET', responseType = '', credentials = false, header = false, omitAsync = false }) => {
                const xhr = new XMLHttpRequest();
                const events = [];
                for (const event of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
                    xhr.addEventListener(event, () => events.push(event + ':' + xhr.readyState));
                }
                return new Promise(resolve => {
                    xhr.addEventListener('loadend', () => resolve({
                        status: xhr.status, type: xhr.getResponseHeader('Content-Type'),
                        responseUrl: xhr.responseURL,
                        text: responseType === '' ? xhr.responseText : null,
                        xmlRoot: (responseType === '' || responseType === 'document') ? xhr.responseXML?.documentElement?.nodeName : null,
                        ads: (responseType === '' || responseType === 'document') ? xhr.responseXML?.querySelectorAll('Ad').length : null,
                        events
                    }), { once: true });
                    if (omitAsync) xhr.open(method, url); else xhr.open(method, url, true);
                    xhr.responseType = responseType;
                    xhr.withCredentials = credentials;
                    xhr.timeout = 3000;
                    if (header) xhr.setRequestHeader('X-Fixture', 'synthetic');
                    xhr.send();
                });
            }, { url: makeAdUrl(), ...options });
        }

        await t.test('captured shape returns native 200 XML without an external request', async () => {
            const count = networkRequests.length;
            const result = await request();
            assert.equal(result.status, 200);
            assert.match(result.type, /^application\/xml/);
            assert.equal(result.text, '<VAST version="3.0"></VAST>');
            assert.equal(result.xmlRoot, 'VAST');
            assert.equal(result.ads, 0);
            assert.equal(networkRequests.length, count);
            assert.ok(result.responseUrl.startsWith('data:application/xml'));
            assert.deepEqual(result.events.filter(e => !e.startsWith('progress:')), [
                'readystatechange:1', 'loadstart:1', 'readystatechange:2',
                'readystatechange:3', 'readystatechange:4', 'load:4', 'loadend:4'
            ]);
        });

        await t.test('credentials, custom headers and document response type stay native', async () => {
            const result = await request({ responseType: 'document', credentials: true, header: true });
            assert.equal(result.status, 200);
            assert.equal(result.xmlRoot, 'VAST');
            assert.equal(result.ads, 0);
        });

        await t.test('two-argument open and URL objects work', async () => {
            assert.equal((await request({ omitAsync: true })).ads, 0);
            const result = await page.evaluate(url => new Promise(resolve => {
                const xhr = new XMLHttpRequest();
                xhr.open('get', new URL(url), true);
                xhr.onloadend = () => resolve(xhr.responseXML?.querySelectorAll('Ad').length);
                xhr.send();
            }), makeAdUrl());
            assert.equal(result, 0);
        });

        const untouched = [
            ['another method', { method: 'POST' }],
            ['another host', { url: makeAdUrl().replace('edge.ads.twitch.tv', 'example.test') }],
            ['another path', { url: makeAdUrl().replace('/2018-01-01/3p/ads?', '/ads?') }],
            ['another format', { url: makeAdUrl({ rt: 'json' }) }],
            ['midroll outside supported scope', { url: makeAdUrl({ bp: 'midroll' }) }],
            ['another VOD', { url: makeAdUrl({ u: 'https://www.twitch.tv/videos/987654321' }) }],
            ['a live URL in the request', { url: makeAdUrl({ u: 'https://www.twitch.tv/fixture_channel' }) }],
            ['a live content marker', { url: makeAdUrl({ pj: JSON.stringify({ delivery_type: 'csai', adunit: 'web_csai', v: 'LIVE' }) }) }],
            ['malformed metadata', { url: makeAdUrl({ pj: '{' }) }],
            ['a banner slot', { url: makeAdUrl({ slots: JSON.stringify([{ id: 'homepage', mt: 'd' }]) }) }],
            ['ambiguous duplicate parameter', { url: makeAdUrl() + '&rt=json' }]
        ];
        for (const [scenario, options] of untouched) {
            await t.test(`passes through ${scenario}`, async () => {
                const result = await request(options);
                assert.equal(result.status, 200);
                assert.equal(result.ads, 1);
                assert.match(result.responseUrl, /^https:/);
            });
        }

        await t.test('SPA transition to live passes through, return to VOD is handled', async () => {
            await page.evaluate(() => history.pushState({}, '', '/fixture_channel'));
            assert.equal((await request()).ads, 1);
            await page.evaluate(() => history.pushState({}, '', '/videos/123456789'));
            assert.equal((await request()).ads, 0);
        });

        await t.test('XHR can be reused for ordinary requests', async () => {
            const result = await page.evaluate(async url => {
                const xhr = new XMLHttpRequest();
                const send = target => new Promise(resolve => {
                    xhr.open('GET', target, true);
                    xhr.onloadend = () => resolve({ url: xhr.responseURL, ads: xhr.responseXML?.querySelectorAll('Ad').length });
                    xhr.send();
                });
                return [await send(url), await send('/ordinary.xml'), await send(url)];
            }, makeAdUrl());
            assert.deepEqual(result.map(r => r.ads), [0, 1, 0]);
            assert.match(result[1].url, /ordinary\.xml$/);
        });

        await t.test('abort before send and immediately after send stay native', async () => {
            const result = await page.evaluate(async url => {
                async function exercise(Xhr, target) {
                    const before = new Xhr();
                    before.open('GET', target, true);
                    before.abort();
                    const stateAfterAbortBeforeSend = before.readyState;
                    let beforeError;
                    await new Promise(resolve => {
                        before.onloadend = resolve;
                        try { before.send(); } catch (error) { beforeError = error.name; resolve(); }
                    });
                    const after = new Xhr();
                    const events = [];
                    for (const type of ['abort', 'load', 'loadend']) after.addEventListener(type, () => events.push(type));
                    after.open('GET', target, true);
                    after.send();
                    after.abort();
                    return { stateAfterAbortBeforeSend, beforeState: before.readyState, beforeError, afterState: after.readyState, events };
                }
                const frame = document.createElement('iframe');
                document.body.appendChild(frame);
                const native = await exercise(frame.contentWindow.XMLHttpRequest, 'data:application/xml,%3CVAST%20version="3.0"/%3E');
                const candidate = await exercise(XMLHttpRequest, url);
                frame.remove();
                return { native, candidate };
            }, makeAdUrl());
            assert.deepEqual(result.candidate, result.native);
            assert.equal(result.candidate.stateAfterAbortBeforeSend, 1);
            assert.equal(result.candidate.beforeState, 4);
            assert.equal(result.candidate.afterState, 0);
            assert.deepEqual(result.candidate.events, ['abort', 'loadend']);
        });

        await t.test('native validation and synchronous open are preserved', async () => {
            const result = await page.evaluate(url => {
                let missingUrlError;
                try { new XMLHttpRequest().open('GET'); } catch (error) { missingUrlError = error.name; }
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, false);
                xhr.send();
                return { missingUrlError, status: xhr.status, ads: xhr.responseXML?.querySelectorAll('Ad').length };
            }, makeAdUrl());
            assert.deepEqual(result, { missingUrlError: 'TypeError', status: 200, ads: 0 });
        });

        await t.test('existing open wrapper receives untouched additional arguments', async () => {
            const fresh = await context.newPage();
            await fresh.goto('https://www.twitch.tv/videos/123456789');
            const args = await fresh.evaluate(async ({ url, source }) => {
                // Use a fresh realm with no userscript to install a pre-existing wrapper first.
                const frame = document.createElement('iframe');
                document.body.appendChild(frame);
                const Native = frame.contentWindow.XMLHttpRequest;
                const realOpen = Native.prototype.open;
                let captured;
                Native.prototype.open = function (...args) { captured = args; return realOpen.apply(this, args); };
                window.XMLHttpRequest = Native;
                window[Symbol.for('MATTEO12SA.vaft.vodVastTest')] = false;
                (0, eval)(source);
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, true, 'fictional-user', 'fictional-password');
                return { count: captured.length, method: captured[0], local: captured[1].startsWith('data:'), rest: captured.slice(2) };
            }, { url: makeAdUrl(), source });
            assert.deepEqual(args, { count: 5, method: 'GET', local: true, rest: [true, 'fictional-user', 'fictional-password'] });
            await fresh.close();
        });

        await t.test('duplicate installation does not stack the wrapper', async () => {
            assert.equal(await page.evaluate(source => {
                const previous = XMLHttpRequest.prototype.open;
                (0, eval)(source);
                return previous === XMLHttpRequest.prototype.open;
            }, source), true);
        });

        for (const [order, first, second] of [
            ['companion then full userscript', addonSource, source],
            ['full userscript then companion', source, addonSource]
        ]) {
            await t.test(`one native XHR wrapper with ${order}`, async () => {
                const isolated = await browser.newContext({ serviceWorkers: 'block' });
                try {
                    let externalRequests = 0;
                    await isolated.route('**/*', async route => {
                        if (!route.request().isNavigationRequest()) externalRequests++;
                        await route.fulfill({ status: 200, contentType: 'text/html',
                            body: '<!doctype html><title>Coexistence fixture</title>' });
                    });
                    await isolated.addInitScript({ content: first +
                        '\nwindow.__testOpen = XMLHttpRequest.prototype.open;\n' + second });
                    const isolatedPage = await isolated.newPage();
                    await isolatedPage.goto('https://www.twitch.tv/videos/123456789');
                    const result = await isolatedPage.evaluate(url => new Promise(resolve => {
                        const sameWrapper = window.__testOpen === XMLHttpRequest.prototype.open;
                        const xhr = new XMLHttpRequest();
                        xhr.open('GET', url);
                        xhr.onloadend = () => resolve({ sameWrapper, status: xhr.status,
                            body: xhr.responseText, responseUrl: xhr.responseURL });
                        xhr.send();
                    }), makeAdUrl());
                    assert.equal(result.sameWrapper, true);
                    assert.equal(result.status, 200);
                    assert.equal(result.body, '<VAST version="3.0"></VAST>');
                    assert.match(result.responseUrl, /^data:/);
                    assert.equal(externalRequests, 0);
                } finally {
                    await isolated.close();
                }
            });
        }

        await t.test('explicit CSP allowing data accepts the response', async () => {
            await page.goto('https://www.twitch.tv/videos/123456789?policy=allow');
            assert.equal((await request()).ads, 0);
        });
        await t.test('CSP forbidding data produces an error: documented limitation', async () => {
            await page.goto('https://www.twitch.tv/videos/123456789?policy=deny');
            const result = await request();
            assert.equal(result.status, 0);
            assert.ok(result.events.some(e => e.startsWith('error:')));
        });

        console.log(`${name} ${browser.version()}: all requests served by local fixtures; no Twitch or extensions tested.`);
    });
}
