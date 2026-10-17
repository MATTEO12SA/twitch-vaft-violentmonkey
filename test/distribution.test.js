const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { config } = require('../src/config');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'vaft.user.js'), 'utf8');

test('distributed metadata preserves identity and owns updates without expanding privileges', () => {
    const block = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)[1];
    const values = key => [...block.matchAll(new RegExp(`^// @${key} +(.+)$`, 'gm'))].map(match => match[1].trim());
    assert.deepEqual(values('name'), ['TwitchAD VAFT MATTEO12SA']);
    assert.deepEqual(values('namespace'), ['https://github.com/MATTEO12SA/twitch-vaft-violentmonkey']);
    assert.deepEqual(values('version'), [config.version]);
    assert.equal(require('../package.json').version, config.version);
    for (const key of ['updateURL', 'downloadURL']) assert.deepEqual(values(key), ['https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js']);
    assert.deepEqual(values('match'), ['https://www.twitch.tv/*', 'https://twitch.tv/*']);
    assert.deepEqual(values('grant'), ['none']);
    assert.deepEqual(values('run-at'), ['document-start']);
    assert.deepEqual(values('inject-into'), ['page']);
    assert.deepEqual(values('require'), []);
    assert.deepEqual(values('license'), ['MIT']);
    assert.equal(config.debug, false);
    assert.equal(config.vodAdSkipping, false);
});

test('committed userscript is exactly reproducible and parses as browser JavaScript', () => {
    execFileSync(process.execPath, ['tools/build.js', '--check'], { cwd: root });
    new vm.Script(source);
    assert.doesNotMatch(source, /module\.exports|require\(['"]node:/);
});

test('distribution does not initialize in an iframe or twice in the same page', () => {
    const frame = { top: {}, self: {} };
    vm.runInNewContext(source, { window: frame });
    assert.equal(frame.__VAFT_MATTEO_ACTIVE__, undefined);
    const duplicate = { __VAFT_MATTEO_ACTIVE__: true };
    duplicate.self = duplicate.top = duplicate;
    vm.runInNewContext(source, { window: duplicate });
    assert.equal(duplicate.__VAFT_MATTEO_ACTIVE__, true);
});

test('complete generated bundle initializes at document-start and disposes on pagehide', async () => {
    const timers = new Set();
    const win = new EventTarget();
    const originalFetch = async () => new Response('fixture');
    Object.assign(win, { URL, Request, Response, Headers, Blob, AbortController, DOMException, TextDecoder,
        fetch: originalFetch, Worker: class Worker {}, console,
        location: { href: 'https://www.twitch.tv/channel' },
        setTimeout(callback) { timers.add(callback); return callback; },
        clearTimeout(callback) { timers.delete(callback); }
    });
    win.self = win.top = win;
    const doc = { documentElement: {}, querySelector: () => null, querySelectorAll: () => [] };
    const sandbox = { window: win, document: doc, URL, Date, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
        MutationObserver: class { observe() {} disconnect() {} } };
    vm.runInNewContext(source, sandbox);
    assert.equal(win.__VAFT_MATTEO_ACTIVE__, true);
    assert.equal(win.__VAFT_MATTEO_DEBUG__, undefined);
    assert.notEqual(win.fetch, originalFetch);
    assert.equal(timers.size, 1);
    assert.equal(await (await win.fetch('https://example.invalid/chat')).text(), 'fixture');
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(timers.size, 0);
    assert.equal(win.fetch, originalFetch);
});
