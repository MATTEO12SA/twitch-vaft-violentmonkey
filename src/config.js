// Build-time configuration. No remote dependencies are loaded by VAFT.
const config = {
    version: '37.0.4',
    debug: false,
    vodAdSkipping: false,
    forcePlayerType: 'popout',
    backupPlayerTypes: ['embed', 'popout', 'autoplay'],
    requestTimeoutMs: 8000,
    retryDelaysMs: [2000, 4000, 8000, 16000, 30000],
    minReloadMs: 8000,
    activeIntervalMs: 600,
    idleIntervalMs: 2000,
    mutationDebounceMs: 150,
    maxCacheEntries: 256,
    cacheTtlMs: 120000,
    selectors: { player: '.video-player', reactRoot: '#root' },
    // No verified anti-adblock signatures yet: do not guess from visible text.
    antiAdblockSignatures: []
};

module.exports = { config };
