'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { source, legacySource, vodSource, addonSource, makeAdUrl } = require('./helpers.cjs');

function realm(href = 'https://www.twitch.tv/videos/123456789', framed = false) {
    const calls = [];
    function Xhr() {}
    Xhr.prototype.open = function (...args) { calls.push({ receiver: this, args }); };
    const nativeOpen = Xhr.prototype.open;
    const window = { location: new URL(href) };
    window.self = window;
    window.top = framed ? {} : window;
    const context = vm.createContext({ window, URL, XMLHttpRequest: Xhr });
    return { context, window, Xhr, calls, nativeOpen, run: code => vm.runInContext(code, context) };
}

test('release metadata keeps the existing installation and main update URLs', () => {
    const metadata = name => source.match(new RegExp('^// @' + name + '\\s+(.+)$', 'm'))?.[1].trim();
    assert.equal(metadata('name'), 'TwitchAD VAFT MATTEO12SA');
    assert.equal(metadata('namespace'), 'https://github.com/MATTEO12SA/twitch-vaft-violentmonkey');
    assert.equal(metadata('version'), '37.0.5');
    assert.equal(metadata('updateURL'), 'https://raw.githubusercontent.com/MATTEO12SA/Twitch-Ad-Block-Directs-VOD/main/vaft.user.js');
    assert.equal(metadata('downloadURL'), metadata('updateURL'));
    assert.equal(metadata('run-at'), 'document-start');
    assert.equal(metadata('inject-into'), 'page');
    assert.equal(metadata('grant'), 'none');
    assert.doesNotMatch(source, /^\/\/ @require\s/m);
    new vm.Script(source);
});

test('legacy live engine is byte-identical to 37.0.3 after normalizing line endings', () => {
    const body = legacySource.slice(legacySource.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length).trim();
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'),
        'c8ccd30292db9b7761d29489527a90efcafc5c7a02b95cda26ce0cbffe7003af');
});

test('integrated VOD module preserves the tested add-on except its explicit origin guard', () => {
    const guard = "    // Keep the scope of the validated companion's @match rules.\n" +
        "    if (window.location.origin !== 'https://www.twitch.tv' && window.location.origin !== 'https://twitch.tv') return;\n\n";
    assert.ok(vodSource.includes(guard));
    assert.equal(vodSource.replace(guard, '').trim(), addonSource.trim());
});

test('matched pre-roll becomes an empty VAST, while this and open arguments are preserved', () => {
    const r = realm(); r.run(vodSource);
    const xhr = new r.Xhr();
    xhr.open('GET', makeAdUrl(), false, 'fictional-user', 'fictional-password');
    const call = r.calls[0];
    assert.equal(call.receiver, xhr);
    assert.equal(call.args[0], 'GET');
    assert.deepEqual(call.args.slice(2), [false, 'fictional-user', 'fictional-password']);
    const local = new URL(call.args[1]);
    assert.equal(local.protocol, 'data:');
    assert.equal(decodeURIComponent(call.args[1].split(',')[1]), '<VAST version="3.0"></VAST>');
});

const passthroughCases = [
    ['POST', 'POST', makeAdUrl()],
    ['another domain', 'GET', makeAdUrl().replace('edge.ads.twitch.tv', 'other.example')],
    ['HTTP', 'GET', makeAdUrl().replace('https:', 'http:')],
    ['other endpoint', 'GET', makeAdUrl().replace('/2018-01-01/3p/ads?', '/ads?')],
    ['credentials in URL', 'GET', makeAdUrl().replace('https://', 'https://fictional:password@')],
    ['another format', 'GET', makeAdUrl({ rt: 'json' })],
    ['mid-roll outside supported scope', 'GET', makeAdUrl({ bp: 'midroll' })],
    ['other publisher', 'GET', makeAdUrl({ pbid: 'other' })],
    ['another VOD', 'GET', makeAdUrl({ u: 'https://www.twitch.tv/videos/987654321' })],
    ['live playback URL', 'GET', makeAdUrl({ u: 'https://www.twitch.tv/fixture_channel' })],
    ['foreign page URL', 'GET', makeAdUrl({ u: 'https://other.example/videos/123456789' })],
    ['invalid page URL', 'GET', makeAdUrl({ u: 'invalid' })],
    ['live content', 'GET', makeAdUrl({ pj: JSON.stringify({ delivery_type: 'csai', adunit: 'web_csai', v: 'LIVE' }) })],
    ['unknown insertion type', 'GET', makeAdUrl({ pj: JSON.stringify({ delivery_type: 'unknown', adunit: 'web_csai', v: 'ARCHIVE' }) })],
    ['malformed JSON', 'GET', makeAdUrl({ pj: '{' })],
    ['missing JSON object', 'GET', makeAdUrl({ pj: 'null' })],
    ['oversized metadata', 'GET', makeAdUrl({ pj: ' '.repeat(8193) })],
    ['banner slot', 'GET', makeAdUrl({ slots: JSON.stringify([{ id: 'homepage', mt: 'd' }]) })],
    ['multiple slots', 'GET', makeAdUrl({ slots: JSON.stringify([{ id: 'twitch-player-ui', mt: 'v' }, { id: 'other', mt: 'v' }]) })],
    ['malformed slots', 'GET', makeAdUrl({ slots: '[' })],
    ['duplicate field', 'GET', makeAdUrl() + '&rt=json'],
    ['missing field', 'GET', makeAdUrl().replace('pbid=twitch&', '')]
];
for (const [name, method, url] of passthroughCases) {
    test(`leaves ${name} untouched`, () => {
        const r = realm(); r.run(vodSource);
        const xhr = new r.Xhr(); xhr.open(method, url);
        assert.equal(r.calls[0].receiver, xhr);
        assert.deepEqual(r.calls[0].args, [method, url]);
    });
}

for (const href of ['https://www.twitch.tv/fixture_channel', 'https://www.twitch.tv/', 'https://www.twitch.tv/videos/987654321']) {
    test(`does not intercept the captured VOD request on ${new URL(href).pathname}`, () => {
        const r = realm(href); r.run(vodSource);
        new r.Xhr().open('GET', makeAdUrl());
        assert.equal(r.calls[0].args[1], makeAdUrl());
    });
}

for (const href of ['http://www.twitch.tv/videos/123456789', 'https://clips.twitch.tv/videos/123456789', 'https://player.twitch.tv/videos/123456789']) {
    test(`does not install VOD hooks at ${new URL(href).origin}`, () => {
        const r = realm(href); r.run(vodSource);
        assert.equal(r.Xhr.prototype.open, r.nativeOpen);
    });
}

test('does not install VOD hooks in an iframe', () => {
    const r = realm(undefined, true); r.run(vodSource);
    assert.equal(r.Xhr.prototype.open, r.nativeOpen);
});

test('SPA navigation reads the current VOD on each call', () => {
    const r = realm(); r.run(vodSource);
    const xhr = new r.Xhr(); xhr.open('GET', makeAdUrl());
    r.window.location = new URL('https://www.twitch.tv/fixture_channel');
    xhr.open('GET', makeAdUrl());
    r.window.location = new URL('https://www.twitch.tv/videos/123456789');
    xhr.open('GET', makeAdUrl());
    assert.deepEqual(r.calls.map(c => c.args[1].startsWith('data:')), [true, false, true]);
});

for (const [label, first, second] of [
    ['old add-on then integrated module', addonSource, vodSource],
    ['integrated module then old add-on', vodSource, addonSource],
    ['integrated module twice', vodSource, vodSource]
]) {
    test(`only one XHR wrapper with ${label}`, () => {
        const r = realm(); r.run(first);
        const installed = r.Xhr.prototype.open;
        r.run(second);
        assert.equal(r.Xhr.prototype.open, installed);
        new r.Xhr().open('GET', makeAdUrl());
        assert.equal(r.calls.length, 1);
        assert.ok(r.calls[0].args[1].startsWith('data:'));
    });
}

test('pass-through preserves native arity and unusual arguments', () => {
    const r = realm(); r.run(vodSource);
    new r.Xhr().open('GET');
    assert.deepEqual(r.calls[0].args, ['GET']);
    const unusual = { toString() { throw new Error('should be left to native XHR'); } };
    new r.Xhr().open('GET', unusual);
    assert.equal(r.calls[1].args[1], unusual);
});
