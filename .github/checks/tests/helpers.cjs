'use strict';

const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'vaft.user.js'), 'utf8').replace(/\r\n/g, '\n');
const marker = '// VOD pre-roll:';
const markerOffset = source.indexOf(marker);
if (markerOffset === -1) throw new Error('VOD integration marker is missing');
const vodSource = source.slice(source.indexOf('(() => {', markerOffset));
const legacySource = source.slice(0, markerOffset).trim();
const addonSource = fs.readFileSync(path.join(__dirname, 'fixtures', 'vod-addon-0.1.0.js'), 'utf8').replace(/\r\n/g, '\n');

// Fictional, minimal values only; no user identifiers, cookies or tracking links.
function makeAdUrl(patch = {}) {
    const params = new URLSearchParams({
        rt: 'vast3', bp: 'preroll', pbid: 'twitch',
        u: 'https://www.twitch.tv/videos/123456789',
        pj: JSON.stringify({ delivery_type: 'csai', adunit: 'web_csai', v: 'ARCHIVE' }),
        slots: JSON.stringify([{ id: 'twitch-player-ui', mt: 'v' }]),
        ...patch
    });
    return 'https://edge.ads.twitch.tv/2018-01-01/3p/ads?' + params;
}

module.exports = { source, legacySource, vodSource, addonSource, makeAdUrl };
