'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHlsTools } = require('../src/hls.js');
const hls = createHlsTools();
const base = 'https://video.example.invalid/channel/index.m3u8?token=synthetic';
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('the factory can be injected with toString without Node dependencies', () => {
    const injected = vm.runInNewContext('(' + createHlsTools.toString() + ')()', { URL });
    assert.equal(injected.getServerTime('#EXTM3U'), null);
    assert.equal(injected.classifyManifestURL(base).kind, 'playlist');
});

test('attribute parser keeps quoted commas, prefixes, zeroes and missing values safe', () => {
    const attrs = hls.parseAttributes('#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.4,mp4a.40.2",FRAME-RATE=60');
    assert.equal(attrs.RESOLUTION, '1920x1080');
    assert.equal(attrs.CODECS, 'avc1.4,mp4a.40.2');
    assert.equal(attrs['FRAME-RATE'], '60');
    assert.equal(hls.parseAttributes('COUNT=0').COUNT, '0');
    assert.deepEqual(Object.keys(hls.parseAttributes(null)), []);
    assert.equal(hls.parseAttributes('CODECS="broken,RESOLUTION=1920x1080').CODECS, '');
});

test('missing SERVER-TIME is harmless and replacement preserves CRLF and handles zero', () => {
    assert.equal(hls.getServerTime('#EXTM3U'), null);
    assert.equal(hls.getServerTime('#EXTM3U', true), null);
    const old = '#EXTM3U\r\n#EXT-X-TWITCH-INFO:SERVER-TIME="123.5",NODE="test"\r\n';
    assert.equal(hls.getServerTime(old), '123.5');
    assert.equal(hls.replaceServerTime(old, 0), old.replace('123.5', '0'));
    assert.equal(hls.replaceServerTime(old, null), old);
    assert.equal(hls.replaceServerTime(old, 'bad"value'), old);
    const v2 = '#EXT-X-SESSION-DATA:VALUE="123",DATA-ID="SERVER-TIME"';
    assert.equal(hls.getServerTime(v2, true), '123');
    assert.equal(hls.replaceServerTime(v2, '456', true), v2.replace('123', '456'));
});

test('master URL classification precedes suffix recognition and accepts signed/relative URLs', () => {
    for (const prefix of ['', 'api/', 'api/v2/']) {
        const result = hls.classifyManifestURL(`https://usher.ttvnw.net/${prefix}channel/hls/example.m3u8?sig=synthetic`);
        assert.equal(result.kind, 'live-master');
        assert.equal(result.channel, 'example');
    }
    assert.equal(hls.classifyManifestURL('https://usher.ttvnw.net/vod/123.m3u8?sig=synthetic').vodId, '123');
    assert.equal(hls.classifyManifestURL(new URL(base)).kind, 'playlist');
    assert.equal(hls.classifyManifestURL(new Request(base)).kind, 'playlist');
    assert.equal(hls.classifyManifestURL('../720/index.m3u8?token=synthetic', base).url,
        'https://video.example.invalid/720/index.m3u8?token=synthetic');
    assert.equal(hls.classifyManifestURL('https://usher.ttvnw.net.evil.invalid/channel/hls/example.m3u8').kind, 'playlist');
    assert.equal(hls.classifyManifestURL('https://usher.ttvnw.net:8443/channel/hls/example.m3u8').kind, 'playlist');
    assert.equal(hls.classifyManifestURL('data:text/plain,playlist.m3u8').kind, 'other');
    assert.equal(hls.classifyManifestURL(null, base).kind, 'other');
});

test('master parser tracks incomplete variants but never selects them as a decoder fallback', () => {
    const variants = hls.parseMaster(fixture('synthetic-master.m3u8').replace(/\n/g, '\r\n'), base);
    assert.equal(variants.length, 5);
    assert.equal(variants.filter(variant => variant.Resolution && variant.Codecs).length, 3);
    assert.equal(variants[0].Url, 'https://video.example.invalid/channel/2160p60/index.m3u8?fixture=1');
    assert.equal(variants[1].FrameRate, 60);
    assert.equal(hls.selectVariant(variants, { Resolution: '1920x1080', FrameRate: 30, Codecs: 'avc1.64002A' }).FrameRate, 30);
    assert.equal(hls.selectVariant(variants, { Resolution: '3840x2160', FrameRate: 60, Codecs: 'avc1.64002A' }).Resolution, '1920x1080');
    assert.equal(hls.selectVariant(variants, { Resolution: '3840x2160', FrameRate: 60, Codecs: 'hvc1.2.4' }).Resolution, '3840x2160');
    assert.equal(hls.selectVariant([], {}), null);
});

test('normal EXTINF without ,live and incidental stitched text are not ad evidence', () => {
    const text = '#EXTM3U\n# A stitched blanket is not an ad marker\n#EXTINF:2,\nplain.ts\n#EXTINF:2,a title\nstitched-video.ts\n';
    const result = hls.inspectMedia(text, base);
    assert.equal(result.hasAds, false);
    assert.deepEqual(result.segments.map(segment => segment.isAd), [false, false]);
    assert.equal(result.sanitizedText, text);
});

test('mixed live/ad DATERANGE maps across segments and actually rewrites tracking attributes', () => {
    const input = fixture('synthetic-live-mixed.m3u8').replace(/\n/g, '\r\n');
    const result = hls.inspectMedia(input, base);
    assert.equal(result.hasAds, true);
    assert.deepEqual(result.segments.map(segment => segment.isAd), [false, true, true, false]);
    assert.equal(result.segments[1].url, 'https://video.example.invalid/channel/ad-1.ts');
    assert.equal(result.segments[3].start, 6);
    assert.ok(result.sanitizedText.includes('X-TV-TWITCH-AD-URL="https://www.twitch.tv/"'));
    assert.ok(result.sanitizedText.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://www.twitch.tv/"'));
    assert.ok(result.sanitizedText.includes('#EXT-X-KEY:METHOD=AES-128,URI="example.key"\r\n'));
    assert.ok(!result.sanitizedText.includes('https://ads.example.invalid/'));
    assert.deepEqual(result.vodRanges, []);
});

test('unknown ad extent does not mark ordinary segments or authorize VOD seeks', () => {
    const input = '#EXTM3U\n#EXT-X-DATERANGE:ID="stitched-ad-unknown",START-DATE="2026-01-01T00:00:00Z"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST';
    const result = hls.inspectMedia(input, base);
    assert.equal(result.hasAds, true);
    assert.equal(result.segments[0].isAd, false);
    assert.deepEqual(result.vodRanges, []);
});

test('complete continuous VOD maps a confirmed date range to an exact finite seek range', () => {
    const result = hls.inspectMedia(fixture('synthetic-vod.m3u8'), base);
    assert.equal(result.timelineReliable, true);
    assert.equal(result.isEndList, true);
    assert.deepEqual(result.vodRanges, [{ id: 'stitched-ad-vod', start: 4, end: 12, confirmed: true }]);
    assert.deepEqual(result.segments.map(segment => segment.isAd), [false, true, true, false]);
});

test('partial overlap is ad evidence but does not strip the whole mixed-content segment', () => {
    const input = fixture('synthetic-vod.m3u8').replace('00:00:04Z', '00:00:05Z').replace('00:00:12Z', '00:00:11Z');
    const result = hls.inspectMedia(input, base);
    assert.equal(result.hasAds, true);
    assert.deepEqual(result.segments.map(segment => segment.isAd), [false, false, false, false]);
    assert.deepEqual(result.vodRanges, [{ id: 'stitched-ad-vod', start: 5, end: 11, confirmed: true }]);
});

test('historical DATERANGE outside the current window is not a current ad', () => {
    const input = fixture('synthetic-live-mixed.m3u8').replace('START-DATE="2026-01-01T00:00:02Z"', 'START-DATE="2025-12-31T23:00:00Z"');
    const result = hls.inspectMedia(input, base);
    assert.equal(result.hasAds, false);
    assert.ok(result.segments.every(segment => !segment.isAd));
});

test('discontinuities, missing durations, nonzero sequences and PDT jumps disable VOD seeks', () => {
    const input = fixture('synthetic-vod.m3u8');
    for (const changed of [
        input.replace('ad-1.ts', 'ad-1.ts\n#EXT-X-DISCONTINUITY'),
        input.replace('#EXTINF:4,', '#EXTINF:invalid,'),
        input.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:10'),
        input.replace('ad-1.ts', 'ad-1.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:01:00Z'),
        input.replace('#EXT-X-ENDLIST', '')
    ]) {
        const result = hls.inspectMedia(changed, base);
        assert.equal(result.timelineReliable, false);
        assert.deepEqual(result.vodRanges, []);
    }
});

test('a later DATERANGE can finish an existing ID, conflicting metadata cannot authorize seeks', () => {
    const input = fixture('synthetic-vod.m3u8').replace(',END-DATE="2026-01-01T00:00:12Z"', '')
        .replace('#EXT-X-ENDLIST', '#EXT-X-DATERANGE:ID="stitched-ad-vod",END-DATE="2026-01-01T00:00:12Z"\n#EXT-X-ENDLIST');
    assert.equal(hls.inspectMedia(input, base).vodRanges[0].end, 12);
    const conflict = input.replace('#EXT-X-ENDLIST', '#EXT-X-DATERANGE:ID="stitched-ad-vod",START-DATE="2026-01-01T00:00:06Z"\n#EXT-X-ENDLIST');
    assert.deepEqual(hls.inspectMedia(conflict, base).vodRanges, []);
});

test('explicit EXTINF title can map a VOD interval; invalid and empty playlists stay safe', () => {
    const input = '#EXTM3U\n#EXTINF:2,live\nlive.ts\n#EXTINF:2,stitched-ad\nad.ts\n#EXT-X-ENDLIST';
    const result = hls.inspectMedia(input, base);
    assert.deepEqual(result.segments.map(segment => segment.isAd), [false, true]);
    assert.deepEqual(result.vodRanges, [{ id: 'segment-1', start: 2, end: 4, confirmed: true }]);
    assert.equal(hls.inspectMedia('', base).timelineReliable, false);
    assert.equal(hls.inspectMedia(null, base).hasAds, false);
    assert.equal(hls.inspectMedia(input.replace('#EXTM3U\n', ''), base).timelineReliable, false);
});
