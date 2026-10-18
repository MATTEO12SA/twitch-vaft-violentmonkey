const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createWorkerEngine } = require('../src/worker');
const { createNetworkTools } = require('../src/network');
const { createHlsTools } = require('../src/hls');
const { config } = require('../src/config');

const masterURL = 'https://usher.ttvnw.net/api/channel/hls/channel.m3u8?fixture=1';
const mediaURL = 'https://video.example.invalid/live/index.m3u8?fixture=1';
const backupURL = 'https://video.example.invalid/backup/index.m3u8';
const master = (url = mediaURL, codec = 'avc1.4D001E') => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="${codec}"\n${url}\n`;
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:2,\nnormal.ts\n';
const ad = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,stitched-ad\nad.ts\n#EXT-X-TWITCH-PREFETCH:ad-next.ts\n';
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ fetch, token = 'failure', context = { kind: 'live', id: 'channel', epoch: 1 }, options = {} } = {}) {
    let timestamp = 0;
    let timerId = 0;
    const timers = new Map();
    const listeners = new Set();
    const messages = [];
    const calls = [];
    const env = Object.create(globalThis);
    Object.assign(env, {
        location: { href: 'https://www.twitch.tv/channel' },
        Date: { now: () => timestamp },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: timestamp + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
        postMessage(message) {
            messages.push(message);
            if (message.type === 'token' && token !== 'hang') queueMicrotask(() => receive({
                ...message, type: 'token-result', ...(token === 'success' ? { value: 'fixture', signature: 'fixture' } : { error: 'NetworkError' })
            }));
        },
        fetch(input, init) {
            const url = input instanceof Request ? input.url : String(input);
            calls.push({ url, init });
            return fetch ? fetch(url, init) : Promise.resolve(new Response(url.includes('usher') ? master() : ad));
        }
    });
    function receive(message) { for (const listener of [...listeners]) listener({ data: message }); }
    const engine = createWorkerEngine(env, { ...config, ...options }, createNetworkTools, createHlsTools, context, 7);
    engine.start();
    async function advance(ms) {
        const until = timestamp + ms;
        await flush();
        let ticks = 0;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(ticks++ < 1000, 'no tight retry loop');
            timestamp = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
            await flush();
        }
        timestamp = until;
        await flush();
    }
    async function dispose() { engine.stop(); await flush(); assert.equal(timers.size, 0); }
    return { engine, env, calls, messages, timers, receive, advance, dispose, now: () => timestamp };
}

test('Worker factory is serializable without module closures', async () => {
    const factory = vm.runInNewContext(`(${createWorkerEngine.toString()})`);
    const f = setup();
    const isolated = factory(f.env, config, createNetworkTools, createHlsTools, { kind: 'unknown', id: null, epoch: 0 }, 8);
    assert.equal(isolated.getDiagnostics().pending, 0);
    isolated.stop();
    await f.dispose();
});

test('untouched responses retain identity and body; non-manifests are never cloned', async () => {
    const original = new Response(clean);
    const mediaResponse = new Response(clean);
    mediaResponse.clone = () => { throw new Error('must not clone a video'); };
    const f = setup({ fetch: async url => url === masterURL ? new Response(master()) : url === mediaURL ? original : mediaResponse });
    await f.env.fetch(new URL(masterURL));
    assert.equal(await f.env.fetch(new Request(mediaURL)), original);
    assert.equal(original.bodyUsed, false);
    assert.equal(await f.env.fetch('https://video.example.invalid/normal.ts'), mediaResponse);
    assert.equal(await original.text(), clean);
    await f.dispose();
});

test('confirmed ads wait with no media, prefetch or segment URI and never fall back to the ad', async () => {
    const f = setup();
    await f.env.fetch(masterURL);
    const response = await f.env.fetch(mediaURL);
    const text = await response.text();
    assert.match(text, /^#EXTM3U/);
    assert.match(text, /MEDIA-SEQUENCE:10/);
    assert.doesNotMatch(text, /ad\.ts|PREFETCH|EXTINF|ENDLIST/);
    await assert.rejects(f.env.fetch('https://video.example.invalid/live/ad.ts'), { name: 'AbortError' });
    assert.ok(f.messages.some(message => message.type === 'status' && message.state === 'waiting-ad'));
    assert.equal(f.engine.getDiagnostics().pending, 0);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('missing CODECS and resolution still register media, so confirmed ads cannot escape', async () => {
    const incomplete = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${mediaURL}\n`;
    const f = setup({ fetch: async url => new Response(url === masterURL ? incomplete : ad) });
    await f.env.fetch(masterURL);
    assert.equal(f.engine.getDiagnostics().media, 1);
    assert.doesNotMatch(await (await f.env.fetch(mediaURL)).text(), /ad\.ts/);
    await f.dispose();
});

test('no ,live is not an ad; malformed/empty HLS and HTTP errors remain unchanged', async () => {
    for (const text of [clean, '', 'not hls']) {
        const response = new Response(text);
        const f = setup({ fetch: async url => url === masterURL ? new Response(master()) : response });
        await f.env.fetch(masterURL);
        assert.equal(await f.env.fetch(mediaURL), response);
        assert.equal(f.messages.some(message => message.type === 'token'), false);
        await f.dispose();
    }
});

test('VOD and unknown playback are not subjected to live filtering', async () => {
    const vodURL = 'https://usher.ttvnw.net/vod/v2/123.m3u8';
    const f = setup({ options: { debug: true }, context: { kind: 'vod', id: '123', epoch: 1 }, fetch: async url => new Response(url === vodURL ? master() : ad + '#EXT-X-ENDLIST\n') });
    await f.env.fetch(vodURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /ad\.ts/);
    assert.ok(f.messages.some(message => message.type === 'vod-ranges'));
    assert.equal(f.messages.some(message => message.type === 'token'), false);
    await f.dispose();
    const g = setup({ context: { kind: 'unknown', id: null, epoch: 1 } });
    await g.env.fetch(masterURL);
    assert.match(await (await g.env.fetch(mediaURL)).text(), /ad\.ts/);
    await g.dispose();
});

test('a master fetched before the DOM player remains associated after context discovery', async () => {
    const f = setup({ context: { kind: 'unknown', id: null, epoch: 0 } });
    await f.env.fetch(masterURL);
    f.engine.setContext({ kind: 'live', id: 'channel', epoch: 1 });
    assert.equal(f.engine.getDiagnostics().media, 1);
    assert.doesNotMatch(await (await f.env.fetch(mediaURL)).text(), /ad\.ts/);
    await f.dispose();
});

test('clean fallback resolves relative media and key URLs and preserves HTTP metadata', async () => {
    const backup = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,live\nsafe.ts\n';
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(master(backupURL));
        if (url === backupURL) return new Response(backup);
        return new Response(ad, { status: 200, statusText: 'OK', headers: { 'X-Fixture': 'kept', 'ETag': 'stale', 'Content-Length': '999' } });
    } });
    await f.env.fetch(masterURL);
    const response = await f.env.fetch(mediaURL);
    assert.equal(response.headers.get('X-Fixture'), 'kept');
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(response.headers.get('ETag'), null);
    const text = await response.text();
    assert.match(text, /https:\/\/video\.example\.invalid\/backup\/safe\.ts/);
    assert.match(text, /URI="https:\/\/video\.example\.invalid\/backup\/key.bin"/);
    assert.doesNotMatch(text, /ad\.ts/);
    await f.dispose();
});

test('clean low-resolution fallback is preferred to waiting and reused on later playlist polls', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(fallback);
        return new Response(url === lowURL ? clean : ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /backup\/normal\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1);
    await f.advance(501);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /backup\/normal\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1, 'reuse the clean lower quality without a new token search');
    assert.equal(f.calls.filter(call => call.url === lowURL).length, 2);
    assert.equal(f.engine.getDiagnostics().recoveryTimers, 0);
    await f.dispose();
});

test('a slow high-quality probe cannot delay a clean compatible low-quality stream', async () => {
    const highURL = 'https://video.example.invalid/backup/slow.m3u8';
    const lowURL = 'https://video.example.invalid/backup/fast.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '640x360');
    let slowSignal;
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL) { slowSignal = init.signal; return new Promise(() => {}); }
        return new Response(url === lowURL ? clean : ad);
    } });
    await f.env.fetch(masterURL);
    const reading = f.env.fetch(mediaURL);
    await flush();
    assert.ok(f.calls.some(call => call.url === lowURL), 'the lower quality is probed while high quality is pending');
    assert.match(await (await reading).text(), /backup\/normal\.ts/);
    assert.equal(slowSignal.aborted, true);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('stalled highest and lowest probes release their slots for a clean intermediate quality', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const midURL = 'https://video.example.invalid/backup/mid.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const fallback = master(highURL) + master(midURL).replace('#EXTM3U\n', '').replace('1920x1080', '640x360') + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    const stalled = [];
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL || url === lowURL) { stalled.push(init.signal); return new Promise(() => {}); }
        return new Response(url === midURL ? clean.replace('normal.ts', 'mid.ts') : ad);
    } });
    await f.env.fetch(masterURL);
    const reading = f.env.fetch(mediaURL);
    await flush();
    assert.equal(stalled.length, 2);
    await f.advance(2000);
    assert.ok(f.calls.some(call => call.url === midURL), 'a stalled pair cannot starve the intermediate variant');
    assert.match(await (await reading).text(), /mid\.ts/);
    assert.equal(stalled.every(signal => signal.aborted), true);
    assert.equal(f.messages.some(message => message.type === 'status' && message.state === 'waiting-ad'), false);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('an AVC refresh cannot reuse the result of a concurrent AV1 fallback search', async () => {
    const av1Live = 'https://video.example.invalid/live/av1.m3u8';
    const avcBackup = 'https://video.example.invalid/backup/avc.m3u8';
    const av1Backup = 'https://video.example.invalid/backup/av1.m3u8';
    const original = master() + master(av1Live, 'av01.0.08M.08').replace('#EXTM3U\n', '');
    const fallback = master(avcBackup) + master(av1Backup, 'av01.0.08M.08').replace('#EXTM3U\n', '');
    let releaseAV1;
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(original);
        if (url.includes('usher')) return new Response(fallback);
        if (url === avcBackup) return new Response(clean.replace('normal.ts', 'avc.ts'));
        if (url === av1Backup) return new Promise(resolve => { releaseAV1 = resolve; });
        return new Response(ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /avc\.ts/);
    await f.advance(501);
    const av1Reading = f.env.fetch(av1Live);
    await flush();
    const avcReading = f.env.fetch(mediaURL);
    await flush();
    releaseAV1(new Response(clean.replace('normal.ts', 'av1.ts')));
    assert.match(await (await av1Reading).text(), /av1\.ts/);
    const avcText = await (await avcReading).text();
    assert.match(avcText, /avc\.ts/);
    assert.doesNotMatch(avcText, /av1\.ts|ad\.ts/);
    await f.dispose();
});

test('quality candidates are bounded, include the lowest resolution, and rotate through intermediate levels', async () => {
    const heights = [1080, 900, 720, 540, 480, 360, 160];
    const urls = heights.map(height => `https://video.example.invalid/backup/${height}.m3u8`);
    const fallback = '#EXTM3U\n' + urls.map((url, index) => master(url).replace('#EXTM3U\n', '').replace('1920x1080', `${heights[index] * 2}x${heights[index]}`)).join('');
    let concurrent = 0;
    let peak = 0;
    const f = setup({ token: 'success', options: { backupPlayerTypes: ['embed'] }, fetch: async url => {
        if (url === masterURL) return new Response(master().replace('1920x1080', '2160x1080'));
        if (url.includes('usher')) return new Response(fallback);
        if (urls.includes(url)) {
            peak = Math.max(peak, ++concurrent);
            await Promise.resolve();
            concurrent--;
        }
        return new Response(ad);
    } });
    await f.env.fetch(masterURL);
    assert.doesNotMatch(await (await f.env.fetch(mediaURL)).text(), /ad\.ts/);
    let probes = f.calls.filter(call => urls.includes(call.url));
    assert.equal(probes.length, 4);
    assert.ok(probes.some(call => call.url === urls[0]));
    assert.ok(probes.some(call => call.url === urls.at(-1)));
    assert.equal(peak, 2);
    await f.advance(2000);
    await f.advance(4000);
    probes = f.calls.filter(call => urls.includes(call.url));
    assert.equal(probes.length, 12);
    assert.equal(new Set(probes.map(call => call.url)).size, urls.length);
    assert.equal(peak, 2);
    await f.dispose();
});

test('fallback never exceeds the requested resolution or substitutes another codec or audio-only variant', async () => {
    const highURL = 'https://video.example.invalid/backup/1080.m3u8';
    const av1URL = 'https://video.example.invalid/backup/av1.m3u8';
    const audioURL = 'https://video.example.invalid/backup/audio.m3u8';
    const lowURL = 'https://video.example.invalid/backup/160.m3u8';
    const fallback = master(highURL) + master(av1URL, 'av01.0.08M.08').replace('#EXTM3U\n', '') + master(audioURL, 'mp4a.40.2').replace('#EXTM3U\n', '').replace(',RESOLUTION=1920x1080', '') + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(master().replace('1920x1080', '1280x720'));
        if (url.includes('usher')) return new Response(fallback);
        return new Response(url === mediaURL ? ad : clean);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /backup\/normal\.ts/);
    assert.equal(f.calls.some(call => [highURL, av1URL, audioURL].includes(call.url)), false);
    await f.dispose();
});

test('background quality improvement keeps low video playing, bounds slow probes, and promotes a clean higher variant', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    let mode = 'ad';
    let highSignal;
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL) {
            if (mode === 'hang') { highSignal = init.signal; return new Promise(() => {}); }
            return new Response(mode === 'clean' ? clean.replace('normal.ts', 'high.ts') : ad);
        }
        return new Response(url === lowURL ? clean.replace('normal.ts', 'low.ts') : ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    mode = 'hang';
    await f.advance(7999);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    assert.equal(f.calls.filter(call => call.url === highURL).length, 1);
    await f.advance(1);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    assert.equal(f.calls.filter(call => call.url === highURL).length, 2);
    await f.advance(1000);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    assert.equal(f.calls.filter(call => call.url === highURL).length, 2);
    await f.advance(7000);
    assert.equal(highSignal.aborted, true);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    mode = 'clean';
    await f.env.fetch(mediaURL);
    await flush();
    assert.match(await (await f.env.fetch(mediaURL)).text(), /high\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('late quality probes cannot promote across a media epoch or the end of an ad', async () => {
    for (const boundary of ['replacement', 'ad-end']) {
        const highURL = 'https://video.example.invalid/backup/high.m3u8';
        const lowURL = 'https://video.example.invalid/backup/low.m3u8';
        const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
        let content = ad;
        let deferHigh = false;
        let releaseHigh;
        let highSignal;
        const f = setup({ token: 'success', fetch: async (url, init) => {
            if (url === masterURL) return new Response(master());
            if (url.includes('usher')) return new Response(fallback);
            if (url === highURL && deferHigh) {
                highSignal = init.signal;
                return new Promise(resolve => { releaseHigh = resolve; });
            }
            return new Response(url === lowURL ? clean.replace('normal.ts', 'low.ts') : url === mediaURL ? content : ad);
        } });
        await f.env.fetch(masterURL);
        assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
        deferHigh = true;
        await f.advance(8000);
        assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
        assert.equal(typeof releaseHigh, 'function');
        if (boundary === 'replacement') f.engine.setContext({ kind: 'live', id: 'channel', epoch: 2 });
        else {
            content = clean;
            assert.equal(await (await f.env.fetch(mediaURL)).text(), clean);
        }
        assert.equal(highSignal.aborted, true);
        releaseHigh(new Response(clean.replace('normal.ts', 'stale-high.ts')));
        await flush();
        deferHigh = false;
        content = ad;
        assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
        assert.equal(f.engine.getDiagnostics().controllers, 0);
        await f.dispose();
    }
});

test('a clean promotion survives a concurrent stale lower-quality refresh failure', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    let upgrade = false;
    let releaseLow;
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL) return new Response(upgrade ? clean.replace('normal.ts', 'high.ts') : ad);
        if (url === lowURL && upgrade) return new Promise(resolve => { releaseLow = resolve; });
        return new Response(url === lowURL ? clean.replace('normal.ts', 'low.ts') : ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    upgrade = true;
    await f.advance(8000);
    const reading = f.env.fetch(mediaURL);
    await flush();
    assert.equal(typeof releaseLow, 'function');
    releaseLow(new Response(ad));
    assert.match(await (await reading).text(), /high\.ts/);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /high\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1);
    await f.dispose();
});

test('an obsolete quality probe is cancelled when its clean backup is replaced', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const replacementURL = 'https://video.example.invalid/replacement/index.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    let phase = 'initial';
    let releaseHigh;
    let highSignal;
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Response(phase === 'replace' ? master(replacementURL).replace('1920x1080', '640x360') : fallback);
        if (url === highURL && phase !== 'initial') {
            highSignal = init.signal;
            return new Promise(resolve => { releaseHigh = resolve; });
        }
        if (url === replacementURL) return new Response(clean.replace('normal.ts', 'replacement.ts'));
        if (url === lowURL && phase !== 'replace') return new Response(clean.replace('normal.ts', 'low.ts'));
        return new Response(ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    phase = 'upgrade';
    await f.advance(8000);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    phase = 'replace';
    await f.advance(501);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /replacement\.ts/);
    assert.equal(highSignal.aborted, true);
    releaseHigh(new Response(clean.replace('normal.ts', 'obsolete-high.ts')));
    await flush();
    assert.match(await (await f.env.fetch(mediaURL)).text(), /replacement\.ts/);
    await f.dispose();
});

test('an in-flight upgrade cannot override a later lower resolution selection', async () => {
    const selectedLowURL = 'https://video.example.invalid/live/360.m3u8';
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const original = master() + master(selectedLowURL).replace('#EXTM3U\n', '').replace('1920x1080', '640x360');
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    let deferHigh = false;
    let releaseHigh;
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(original);
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL && deferHigh) return new Promise(resolve => { releaseHigh = resolve; });
        return new Response(url === lowURL ? clean.replace('normal.ts', 'low.ts') : ad);
    } });
    await f.env.fetch(masterURL);
    await f.env.fetch(mediaURL);
    deferHigh = true;
    await f.advance(8000);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    assert.match(await (await f.env.fetch(selectedLowURL)).text(), /low\.ts/);
    releaseHigh(new Response(clean.replace('normal.ts', 'excess-high.ts')));
    await flush();
    assert.match(await (await f.env.fetch(selectedLowURL)).text(), /low\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1, 'the compatible low cache was retained');
    await f.dispose();
});

test('manual high-to-low-to-high selection keeps clean compatible video and later restores higher quality', async () => {
    const selectedLowURL = 'https://video.example.invalid/live/360.m3u8';
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const original = master() + master(selectedLowURL).replace('#EXTM3U\n', '').replace('1920x1080', '640x360');
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    let lowIsClean = false;
    const f = setup({ token: 'success', fetch: async url => {
        if (url === masterURL) return new Response(original);
        if (url.includes('usher')) return new Response(fallback);
        if (url === highURL) return new Response(clean.replace('normal.ts', 'high.ts'));
        if (url === lowURL && lowIsClean) return new Response(clean.replace('normal.ts', 'low.ts'));
        return new Response(ad);
    } });
    await f.env.fetch(masterURL);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /high\.ts/);
    lowIsClean = true;
    assert.match(await (await f.env.fetch(selectedLowURL)).text(), /low\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 2);
    assert.match(await (await f.env.fetch(mediaURL)).text(), /low\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 2, 'changing back to high quality immediately reuses clean low video');
    await f.advance(8000);
    await f.env.fetch(mediaURL);
    await flush();
    assert.match(await (await f.env.fetch(mediaURL)).text(), /high\.ts/);
    assert.equal(f.messages.filter(message => message.type === 'token').length, 2);
    assert.equal(f.messages.some(message => message.type === 'status' && message.state === 'waiting-ad'), false);
    assert.equal(f.messages.some(message => message.type === 'reload'), false);
    await f.dispose();
});

test('slow master setup cannot give variant probes a fresh eight-second search deadline', async () => {
    const highURL = 'https://video.example.invalid/backup/high.m3u8';
    const lowURL = 'https://video.example.invalid/backup/low.m3u8';
    const fallback = master(highURL) + master(lowURL).replace('#EXTM3U\n', '').replace('1920x1080', '284x160');
    const signals = [];
    let releaseMaster;
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) return new Promise(resolve => { releaseMaster = resolve; });
        if (url === highURL || url === lowURL) { signals.push(init.signal); return new Promise(() => {}); }
        return new Response(ad);
    } });
    await f.env.fetch(masterURL);
    const reading = f.env.fetch(mediaURL);
    await flush();
    await f.advance(7000);
    releaseMaster(new Response(fallback));
    await flush();
    assert.equal(signals.length, 2);
    await f.advance(999);
    assert.equal(signals.every(signal => signal.aborted), false);
    await f.advance(1);
    assert.doesNotMatch(await (await reading).text(), /ad\.ts|EXTINF/);
    assert.equal(signals.every(signal => signal.aborted), true);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    assert.equal(f.engine.getDiagnostics().pending, 0);
    await f.dispose();
});

test('a stalled first profile cannot starve the other profiles on every recovery attempt', async () => {
    let stalledSignal;
    const f = setup({ token: 'success', fetch: async (url, init) => {
        if (url === masterURL) return new Response(master());
        if (url.includes('usher')) {
            const playerType = f.messages.filter(message => message.type === 'token').at(-1).playerType;
            if (playerType === 'embed') { stalledSignal = init.signal; return new Promise(() => {}); }
            return new Response(master(backupURL));
        }
        return new Response(url === backupURL ? clean : ad);
    } });
    await f.env.fetch(masterURL);
    const reading = f.env.fetch(mediaURL);
    await flush();
    await f.advance(8000);
    assert.doesNotMatch(await (await reading).text(), /ad\.ts|EXTINF/);
    assert.equal(stalledSignal.aborted, true);
    await f.advance(2000);
    assert.deepEqual(f.messages.filter(message => message.type === 'token').map(message => message.playerType), ['embed', 'popout']);
    assert.ok(f.messages.some(message => message.type === 'reload'));
    assert.equal(f.messages.filter(message => message.type === 'status').at(-1).state, 'playing');
    await f.dispose();
});

test('simultaneous media requests share one bounded fallback search; caller cancellation settles', async () => {
    const f = setup({ token: 'hang' });
    await f.env.fetch(masterURL);
    const abort = new AbortController();
    const cancelled = assert.rejects(f.env.fetch(mediaURL, { signal: abort.signal }), { name: 'AbortError' });
    const second = f.env.fetch(mediaURL);
    await flush();
    assert.equal(f.messages.filter(message => message.type === 'token').length, 1);
    abort.abort();
    await cancelled;
    await f.advance(8000);
    assert.doesNotMatch(await (await second).text(), /ad\.ts/);
    assert.equal(f.engine.getDiagnostics().pending, 0);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('recovery continues without player polling and uses 2, 4, 8, 16, then 30 second backoff', async () => {
    const f = setup();
    await f.env.fetch(masterURL);
    await f.env.fetch(mediaURL);
    let expectedTokens = 3;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
        await f.advance(delay - 1);
        assert.equal(f.messages.filter(message => message.type === 'token').length, expectedTokens);
        await f.advance(1);
        expectedTokens += 3;
        assert.equal(f.messages.filter(message => message.type === 'token').length, expectedTokens);
    }
    await f.dispose();
});

test('changing channel cancels pending fallback and drops stale results and registries', async () => {
    const f = setup({ token: 'hang' });
    await f.env.fetch(masterURL);
    const reading = assert.rejects(f.env.fetch(mediaURL), { name: 'AbortError' });
    await flush();
    f.engine.setContext({ kind: 'vod', id: '123', epoch: 2 });
    await reading;
    const diagnostics = f.engine.getDiagnostics();
    for (const key of ['streams', 'media', 'pending', 'blockedSegments', 'controllers', 'recoveryTimers']) assert.equal(diagnostics[key], 0);
    await f.dispose();
});

test('HEVC cannot receive AVC bytes until a new master advertises the codec fallback', async () => {
    const originalMaster = master(mediaURL, 'hvc1.2.4') + master(backupURL).replace('#EXTM3U\n', '');
    const f = setup({ token: 'success', fetch: async url => new Response(url === masterURL ? originalMaster : url.includes('usher') ? master(backupURL) : url === backupURL ? clean : ad) });
    await f.env.fetch(masterURL);
    const response = await f.env.fetch(mediaURL);
    assert.doesNotMatch(await response.text(), /normal\.ts|ad\.ts/);
    assert.ok(f.messages.some(message => message.type === 'reload'));
    f.engine.setContext({ kind: 'live', id: 'channel', epoch: 2 });
    const updated = await (await f.env.fetch(masterURL)).text();
    assert.doesNotMatch(updated, /hvc1/);
    assert.match(updated, /avc1/);
    await f.dispose();
});

test('body decoding errors reject instead of leaving the playlist request pending', async () => {
    const f = setup({ fetch: async url => url === masterURL ? new Response(master()) : new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture body failure')); } })) });
    await f.env.fetch(masterURL);
    await assert.rejects(f.env.fetch(mediaURL), /fixture body failure/);
    await f.dispose();
});

test('an old ad request cannot overwrite a clean parallel response with a stale waiting state', async () => {
    let content = ad;
    const f = setup({ token: 'hang', fetch: async url => new Response(url === masterURL ? master() : content) });
    await f.env.fetch(masterURL);
    const stale = assert.rejects(f.env.fetch(mediaURL), { name: 'AbortError' });
    await flush();
    content = clean;
    assert.equal(await (await f.env.fetch(mediaURL)).text(), clean);
    await stale;
    assert.equal(f.messages.filter(message => message.type === 'status').at(-1).state, 'playing');
    assert.equal(f.engine.getDiagnostics().recoveryTimers, 0);
    await f.dispose();
});

test('default VOD handling does not clone or consume even a very large playlist', async () => {
    const response = new Response('fixture');
    response.clone = () => { throw new Error('VOD should pass through'); };
    const f = setup({ context: { kind: 'vod', id: '123', epoch: 1 }, fetch: async () => response });
    assert.equal(await f.env.fetch('https://usher.ttvnw.net/vod/123.m3u8'), response);
    assert.equal(response.bodyUsed, false);
    assert.equal(f.engine.getDiagnostics().media, 0);
    await f.dispose();
});

test('background recovery detects the end of an ad even when the player stops polling', async () => {
    let content = ad;
    const f = setup({ fetch: async url => new Response(url === masterURL ? master() : content) });
    await f.env.fetch(masterURL);
    await f.env.fetch(mediaURL);
    content = clean;
    await f.advance(2000);
    assert.ok(f.messages.some(message => message.type === 'reload'));
    assert.equal(f.engine.getDiagnostics().recoveryTimers, 0);
    assert.equal(f.messages.filter(message => message.type === 'status').at(-1).state, 'resuming');
    await f.dispose();
});

test('same-channel media replacement keeps recovery alive without another player request', async () => {
    let content = ad;
    const f = setup({ fetch: async url => new Response(url === masterURL ? master() : content) });
    await f.env.fetch(masterURL);
    assert.doesNotMatch(await (await f.env.fetch(mediaURL)).text(), /ad\.ts|EXTINF/);
    assert.equal(f.engine.getDiagnostics().recoveryTimers, 1);
    f.engine.setContext({ kind: 'live', id: 'channel', epoch: 2 });
    f.engine.setContext({ kind: 'live', id: 'channel', epoch: 3 });
    content = clean;
    // Twitch stopped requesting playlists after receiving the empty waiting manifest.
    await f.advance(1999);
    assert.equal(f.messages.some(message => message.type === 'reload'), false);
    await f.advance(1);
    assert.deepEqual(f.messages.filter(message => message.type === 'reload').map(message => message.epoch), [3]);
    assert.equal(f.messages.filter(message => message.type === 'status').at(-1).state, 'resuming');
    assert.equal(f.engine.getDiagnostics().recoveryTimers, 0);
    await f.dispose();
});

test('replacement during fallback aborts the old request and recovers only the current live context', async () => {
    let content = ad;
    const f = setup({ token: 'hang', fetch: async url => new Response(url === masterURL ? master() : content) });
    await f.env.fetch(masterURL);
    const oldReading = assert.rejects(f.env.fetch(mediaURL), { name: 'AbortError' });
    await flush();
    assert.equal(f.engine.getDiagnostics().pending, 1);
    f.engine.setContext({ kind: 'live', id: 'channel', epoch: 2 });
    await oldReading;
    content = clean;
    await f.advance(2000);
    assert.deepEqual(f.messages.filter(message => message.type === 'reload').map(message => message.epoch), [2]);
    assert.equal(f.engine.getDiagnostics().pending, 0);
    assert.equal(f.engine.getDiagnostics().controllers, 0);
    await f.dispose();
});

test('rearmed same-channel recovery is cancelled on navigation or shutdown', async () => {
    for (const shutdown of [false, true]) {
        const f = setup();
        await f.env.fetch(masterURL);
        await f.env.fetch(mediaURL);
        f.engine.setContext({ kind: 'live', id: 'channel', epoch: 2 });
        assert.equal(f.engine.getDiagnostics().recoveryTimers, 1);
        if (shutdown) f.engine.stop();
        else f.engine.setContext({ kind: 'live', id: 'other_channel', epoch: 3 });
        const requests = f.calls.length;
        await f.advance(60000);
        assert.equal(f.calls.length, requests);
        assert.equal(f.messages.some(message => message.type === 'reload'), false);
        const diagnostics = f.engine.getDiagnostics();
        for (const key of ['streams', 'media', 'pending', 'blockedSegments', 'controllers', 'recoveryTimers']) assert.equal(diagnostics[key], 0);
        await f.dispose();
    }
});

test('late TwitchNoSub response synthesis is inspected without double-wrapping successful responses', async () => {
    const vodURL = 'https://usher.ttvnw.net/vod/123.m3u8';
    const f = setup({ options: { debug: true }, context: { kind: 'vod', id: '123', epoch: 1 }, fetch: async url => url === vodURL ? new Response('', { status: 403 }) : new Response(clean) });
    const previousFetch = f.env.fetch;
    f.env.fetch = async (input, init) => {
        const result = await previousFetch(input, init);
        return result.status === 403 ? new Response(master()) : result;
    };
    f.engine.refreshFetch();
    assert.equal((await f.env.fetch(vodURL)).status, 200);
    assert.equal(f.engine.getDiagnostics().media, 1);
    await f.env.fetch(mediaURL);
    assert.ok(f.messages.some(message => message.type === 'vod-ranges'));
    await f.dispose();
});

test('long synthetic session keeps owned maps bounded across twenty channels', async () => {
    const f = setup({ options: { maxCacheEntries: 10 } });
    for (let i = 0; i < 20; i++) {
        f.engine.setContext({ kind: 'live', id: `channel${i}`, epoch: i + 2 });
        await f.env.fetch(masterURL.replace('channel.m3u8', `channel${i}.m3u8`));
        await f.env.fetch(mediaURL);
        assert.equal(f.engine.getDiagnostics().streams, 1);
        assert.equal(f.engine.getDiagnostics().media, 1);
        assert.ok(f.engine.getDiagnostics().blockedSegments <= 1);
        await f.advance(180000);
    }
    await f.dispose();
});
