// Self-contained: the build embeds this factory in both the page and its Worker.
function createHlsTools() {
    'use strict';

    function parseAttributes(line) {
        const attributes = Object.create(null);
        if (typeof line !== 'string') return attributes;
        const text = line.trim().replace(/^#[^:]+:/, '');
        // Quoted values may contain commas. Do not split the entire attribute list.
        const pattern = /(?:^|,)\s*([A-Za-z0-9-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^",]*)/g;
        let match;
        while ((match = pattern.exec(text))) {
            const raw = match[2].trim();
            attributes[match[1].toUpperCase()] = raw.startsWith('"')
                ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
                : raw;
        }
        return attributes;
    }

    function getServerTime(text, v2 = false) {
        if (typeof text !== 'string') return null;
        if (v2) {
            for (const line of text.split(/\r?\n/)) {
                if (!line.startsWith('#EXT-X-SESSION-DATA:')) continue;
                const attrs = parseAttributes(line);
                if (attrs['DATA-ID'] === 'SERVER-TIME') return attrs.VALUE || null;
            }
            return null;
        }
        return text.match(/(?:^|[, :])SERVER-TIME="([0-9.]+)"/m)?.[1] ?? null;
    }

    function replaceServerTime(text, time, v2 = false) {
        if (typeof text !== 'string' || time == null || /["\r\n]/.test(String(time))) return text;
        const value = String(time);
        if (!value || (!v2 && !/^\d+(?:\.\d+)?$/.test(value))) return text;
        if (!v2) return text.replace(/(\bSERVER-TIME=")[0-9.]+(")/, (_, start, end) => start + value + end);
        return text.replace(/^#EXT-X-SESSION-DATA:[^\r\n]*/gm, line => {
            if (parseAttributes(line)['DATA-ID'] !== 'SERVER-TIME') return line;
            return line.replace(/(\bVALUE=")[^"]*(")/, (_, start, end) => start + value + end);
        });
    }

    function asURL(input, base) {
        try {
            const value = typeof input === 'string' ? input.trim() : input?.url ?? input?.href;
            if (typeof value !== 'string' || !value) return null;
            return new URL(value, base);
        } catch {
            return null;
        }
    }

    function classifyManifestURL(input, base) {
        const parsed = asURL(input, base);
        if (!parsed || !/^https?:$/.test(parsed.protocol)) return { kind: 'other', url: parsed?.href ?? '' };
        if (parsed.hostname === 'usher.ttvnw.net' && !parsed.port && !parsed.username && !parsed.password) {
            const live = parsed.pathname.match(/^\/(?:api\/(?:v2\/)?)?channel\/hls\/([A-Za-z0-9_]+)\.m3u8$/);
            if (live) return { kind: 'live-master', url: parsed.href, channel: live[1] };
            const vod = parsed.pathname.match(/^\/(?:api\/(?:v2\/)?)?vod\/(?:v2\/)?(\d+)\.m3u8$/);
            if (vod) return { kind: 'vod-master', url: parsed.href, vodId: vod[1] };
        }
        return { kind: /\.m3u8$/i.test(parsed.pathname) ? 'playlist' : 'other', url: parsed.href };
    }

    function resolutionArea(value) {
        const match = typeof value === 'string' && value.match(/^(\d+)x(\d+)$/i);
        if (!match) return null;
        const area = Number(match[1]) * Number(match[2]);
        return Number.isSafeInteger(area) && area > 0 ? area : null;
    }

    function parseMaster(text, baseURL) {
        const variants = [];
        if (typeof text !== 'string') return variants;
        let attrs = null;
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                attrs = parseAttributes(line);
            } else if (line && !line.startsWith('#')) {
                const url = asURL(line, baseURL);
                if (attrs && url && /^https?:$/.test(url.protocol)) {
                    const rate = Number(attrs['FRAME-RATE']);
                    variants.push({
                        Resolution: resolutionArea(attrs.RESOLUTION) ? attrs.RESOLUTION : null,
                        FrameRate: Number.isFinite(rate) && rate > 0 ? rate : null,
                        Codecs: attrs.CODECS || null,
                        Url: url.href
                    });
                }
                attrs = null;
            }
        }
        return variants;
    }

    function videoCodec(value) {
        const codecs = String(value ?? '').toLowerCase().split(',').map(item => item.trim());
        if (codecs.some(codec => /^(avc1|avc3)(\.|$)/.test(codec))) return 'avc';
        if (codecs.some(codec => /^(hev1|hvc1)(\.|$)/.test(codec))) return 'hevc';
        if (codecs.some(codec => /^av01(\.|$)/.test(codec))) return 'av1';
        if (codecs.some(codec => /^vp09(\.|$)/.test(codec))) return 'vp9';
        return null;
    }

    function selectVariant(variants, target = {}) {
        if (!Array.isArray(variants)) return null;
        let candidates = variants.filter(item => item && resolutionArea(item.Resolution) && item.Codecs && item.Url);
        const codec = videoCodec(target?.Codecs);
        const compatible = codec && candidates.filter(item => videoCodec(item.Codecs) === codec);
        if (compatible?.length) candidates = compatible;
        const area = resolutionArea(target?.Resolution);
        const rate = Number(target?.FrameRate);
        return candidates.slice().sort((a, b) => {
            const aArea = resolutionArea(a.Resolution);
            const bArea = resolutionArea(b.Resolution);
            const resolutionDifference = area ? Math.abs(aArea - area) - Math.abs(bArea - area) : bArea - aArea;
            if (resolutionDifference) return resolutionDifference;
            if (!Number.isFinite(rate) || rate <= 0) return 0;
            const distance = item => Number.isFinite(Number(item.FrameRate)) && Number(item.FrameRate) > 0
                ? Math.abs(Number(item.FrameRate) - rate) : Infinity;
            return distance(a) - distance(b);
        })[0] ?? null;
    }

    function isAdDateRange(attrs) {
        return /(?:^|[\s_-])stitched-ad(?:$|[\s_-])/i.test(attrs.CLASS || '') ||
            /(?:^|[\s_-])stitched-ad(?:$|[\s_-])/i.test(attrs.ID || '') ||
            Object.keys(attrs).some(key => key.startsWith('X-TV-TWITCH-AD-'));
    }

    function parseDate(value) {
        // HLS dates are absolute; reject local-time and implementation-defined inputs.
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
        const result = Date.parse(value) / 1000;
        return Number.isFinite(result) ? result : null;
    }

    function inspectMedia(text, baseURL) {
        if (typeof text !== 'string') text = '';
        const segments = [];
        const dated = [];
        const rangesById = new Map();
        const wallTimes = [];
        let pending = null;
        let elapsed = 0;
        let wall = null;
        let complete = /^#EXTM3U(?:\r?\n|$)/.test(text);
        let isEndList = false;
        let hasDiscontinuity = false;
        let sequence = 0;
        let hasUnknownAd = false;
        let hasExplicitTitle = false;
        const sanitizedText = text.replace(/(\bX-TV-TWITCH-AD-(?:CLICK-TRACKING-)?URL=")[^"]*(")/g,
            (_, key, quote) => key + 'https://www.twitch.tv/' + quote);

        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith('#EXTINF:')) {
                if (pending) complete = false;
                const match = line.match(/^#EXTINF:(\d+(?:\.\d+)?),(.*)$/);
                const duration = match ? Number(match[1]) : NaN;
                const titleAd = !!match && /(?:^|[\s,;])stitched-ad(?:$|[\s,;:_-])/i.test(match[2]);
                hasExplicitTitle ||= titleAd;
                pending = { duration, titleAd };
                if (!Number.isFinite(duration) || duration <= 0) complete = false;
            } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                const anchor = parseDate(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
                if (anchor === null || (wall !== null && Math.abs(anchor - wall) > 0.05)) complete = false;
                wall = anchor;
            } else if (line.startsWith('#EXT-X-DATERANGE:')) {
                const attrs = parseAttributes(line);
                const previous = attrs.ID && rangesById.get(attrs.ID);
                if (previous) {
                    // HLS allows a later tag to add END-DATE to the same ID, but not change a value.
                    for (const key of Object.keys(attrs)) {
                        if (previous.attrs[key] !== undefined && previous.attrs[key] !== attrs[key]) previous.conflict = true;
                    }
                    Object.assign(previous.attrs, attrs);
                } else {
                    const entry = { attrs, conflict: false };
                    dated.push(entry);
                    if (attrs.ID) rangesById.set(attrs.ID, entry);
                }
            } else if (line === '#EXT-X-DISCONTINUITY') {
                hasDiscontinuity = true;
                wall = null;
            } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                sequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
                if (!Number.isSafeInteger(sequence) || sequence < 0) complete = false;
            } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
                if (Number(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length)) !== 0) complete = false;
            } else if (line === '#EXT-X-ENDLIST') {
                isEndList = true;
            } else if (line.startsWith('#EXT-X-SKIP:') || line.startsWith('#EXT-X-START:')) {
                complete = false;
            } else if (!line.startsWith('#')) {
                if (!pending) { complete = false; continue; }
                const duration = Number.isFinite(pending.duration) && pending.duration > 0 ? pending.duration : null;
                const url = asURL(line, baseURL);
                if (!url || !/^https?:$/.test(url.protocol)) complete = false;
                segments.push({
                    url: url?.href ?? line,
                    isAd: pending.titleAd,
                    duration,
                    start: elapsed,
                    end: duration === null ? elapsed : elapsed + duration
                });
                wallTimes.push(wall);
                if (duration !== null) {
                    elapsed += duration;
                    if (wall !== null) wall += duration;
                } else {
                    wall = null;
                }
                pending = null;
            }
        }
        if (pending) complete = false;
        const timelineReliable = isEndList && complete && sequence === 0 && !hasDiscontinuity && segments.length > 0;
        const vodRanges = [];
        if (timelineReliable) {
            for (const [index, segment] of segments.entries()) {
                if (segment.isAd) vodRanges.push({ id: 'segment-' + index, start: segment.start, end: segment.end, confirmed: true });
            }
        }
        let dateRangeOverlaps = false;
        for (const entry of dated) {
            const attrs = entry.attrs;
            if (!isAdDateRange(attrs)) continue;
            const start = parseDate(attrs['START-DATE']);
            const explicitEnd = parseDate(attrs['END-DATE']);
            const duration = attrs.DURATION === undefined ? NaN : Number(attrs.DURATION);
            const end = explicitEnd ?? (start !== null && Number.isFinite(duration) && duration > 0 ? start + duration : null);
            if (entry.conflict || start === null || end === null || end <= start ||
                (attrs['END-DATE'] !== undefined && explicitEnd === null) ||
                (explicitEnd !== null && Number.isFinite(duration) && Math.abs(explicitEnd - start - duration) > 0.05)) {
                hasUnknownAd = true;
                continue;
            }
            let mappingMissing = false;
            for (const [index, segment] of segments.entries()) {
                const segmentWall = wallTimes[index];
                if (segmentWall === null || segment.duration === null) { mappingMissing = true; continue; }
                const wallEnd = segmentWall + segment.duration;
                if (segmentWall < end && wallEnd > start) dateRangeOverlaps = true;
                if (segmentWall >= start - 0.001 && wallEnd <= end + 0.001) segment.isAd = true;
            }
            if (mappingMissing || !segments.length) hasUnknownAd = true;
            if (timelineReliable && !mappingMissing) {
                const origin = wallTimes[0];
                if (origin !== null && wallTimes.every((value, index) => Math.abs(value - origin - segments[index].start) <= 0.05) &&
                    start >= origin - 0.001 && end <= origin + elapsed + 0.001) {
                    vodRanges.push({ id: attrs.ID || 'range-' + vodRanges.length,
                        start: Math.max(0, start - origin), end: Math.min(elapsed, end - origin), confirmed: true });
                }
            }
        }
        // Return merged ranges so overlapping metadata cannot cause repeated seeks.
        const mergedRanges = [];
        for (const range of vodRanges.sort((a, b) => a.start - b.start)) {
            const last = mergedRanges[mergedRanges.length - 1];
            if (last && range.start <= last.end + 0.001) last.end = Math.max(last.end, range.end);
            else mergedRanges.push({ ...range });
        }
        return {
            hasAds: hasUnknownAd || hasExplicitTitle || dateRangeOverlaps || segments.some(segment => segment.isAd),
            segments,
            vodRanges: timelineReliable && !hasUnknownAd ? mergedRanges : [],
            sanitizedText,
            isEndList,
            timelineReliable
        };
    }

    return { parseAttributes, getServerTime, replaceServerTime, classifyManifestURL, parseMaster, selectVariant, inspectMedia };
}

// Node test exports
if (typeof module !== 'undefined' && module.exports) module.exports = { createHlsTools };
