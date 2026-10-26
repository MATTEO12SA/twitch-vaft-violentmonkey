(() => {
    'use strict';

    if (window.top !== window.self) return;
    const installedKey = Symbol.for('MATTEO12SA.vaft.vodVastTest');
    if (window[installedKey]) return;

    // VAST 3.0 section 2.4.2.4: an empty VAST denotes a no-ad response.
    const noAdUrl = 'data:application/xml;charset=utf-8,%3CVAST%20version%3D%223.0%22%3E%3C%2FVAST%3E';

    function getVodId(url) {
        if (url.origin !== 'https://www.twitch.tv' && url.origin !== 'https://twitch.tv') return null;
        if (url.username || url.password) return null;
        return url.pathname.match(/^\/videos\/(\d+)\/?$/)?.[1] ?? null;
    }

    function isCapturedVodPreroll(method, input) {
        // Leave unusual arguments to the native implementation without coercing them twice.
        if (typeof method !== 'string' || method.toUpperCase() !== 'GET') return false;
        if (typeof input !== 'string' && !(input instanceof URL)) return false;
        try {
            const page = new URL(window.location.href);
            const vodId = getVodId(page);
            if (!vodId) return false;

            const url = new URL(input, page);
            if (url.origin !== 'https://edge.ads.twitch.tv' ||
                url.pathname !== '/2018-01-01/3p/ads' || url.username || url.password) return false;

            const params = url.searchParams;
            for (const key of ['rt', 'bp', 'pbid', 'u', 'pj', 'slots']) {
                if (params.getAll(key).length !== 1) return false;
            }
            if (params.get('rt') !== 'vast3' || params.get('bp') !== 'preroll' ||
                params.get('pbid') !== 'twitch') return false;
            if (getVodId(new URL(params.get('u'))) !== vodId) return false;

            const detailsText = params.get('pj');
            const slotsText = params.get('slots');
            if (detailsText.length > 8192 || slotsText.length > 4096) return false;
            const details = JSON.parse(detailsText);
            const slots = JSON.parse(slotsText);
            return details?.delivery_type === 'csai' && details?.adunit === 'web_csai' &&
                details?.v === 'ARCHIVE' && Array.isArray(slots) && slots.length === 1 &&
                slots[0]?.id === 'twitch-player-ui' && slots[0]?.mt === 'v';
        } catch {
            return false;
        }
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (!isCapturedVodPreroll(method, url)) return originalOpen.apply(this, arguments);
        const args = Array.from(arguments);
        args[1] = noAdUrl;
        // Native XHR handles headers, response types, abort, reuse and events.
        return originalOpen.apply(this, args);
    };
    window[installedKey] = true;
})();
