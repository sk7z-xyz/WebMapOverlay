const {
    MAX_SIGNATURE_BYTES, installerName, loadTrustedKeys, verifyEnvelope,
    assertUpdateMatches, assertInstallerMatches
} = require('./update-signature');

const RELEASE_BASE = 'https://github.com/sk7z-xyz/WebMapOverlay/releases/download/';
const SIGNATURE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function fetchReleaseSignature(version, fetchImpl) {
    const fetch = fetchImpl || globalThis.fetch;
    let url = new URL(`v${version}/${installerName(version)}.sig.json`, RELEASE_BASE);
    const signal = AbortSignal.timeout(15000);
    for (let redirects = 0; redirects <= 3; redirects++) {
        if (url.protocol !== 'https:' || !SIGNATURE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
            throw new Error('Unexpected release signature URL');
        }
        const response = await fetch(url, {redirect: 'manual', signal});
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('Missing release signature redirect');
            url = new URL(location, url);
            continue;
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            throw new Error(`Release signature download failed (${response.status})`);
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                length += value.length;
                if (length > MAX_SIGNATURE_BYTES) throw new Error('Release signature is too large');
                chunks.push(Buffer.from(value));
            }
        } finally { await reader.cancel(); }
        return Buffer.concat(chunks, length);
    }
    throw new Error('Too many release signature redirects');
}

function createSignedUpdateGuard(updater, {keyDocument, currentVersion, fetchSignature = fetchReleaseSignature}) {
    // Disable every automatic installation path. Only install() below may launch an installer.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    const keys = loadTrustedKeys(keyDocument);
    const prepared = new Map();
    let activeVersion = null;
    let verified = null;

    function requireKeys() {
        if (keys.size === 0) throw new Error('自動更新の署名鍵が未登録です。公開鍵の登録後に利用できます。');
    }

    return {
        isConfigured: () => keys.size > 0,
        async prepare(info) {
            requireKeys();
            // Validate the version before using it in a URL. The filename is fixed by the application.
            installerName(info.version);
            const payload = verifyEnvelope(await fetchSignature(info.version), keys);
            assertUpdateMatches(payload, info, currentVersion);
            prepared.set(payload.version, payload);
        },
        async download(info) {
            requireKeys();
            if (activeVersion !== null) throw new Error('An update download is already in progress');
            const payload = prepared.get(info.version);
            if (!payload) throw new Error('Update signature has not been verified');
            assertUpdateMatches(payload, info, currentVersion);
            activeVersion = info.version;
            verified = null;
            try {
                return await updater.downloadUpdate();
            } finally {
                activeVersion = null;
            }
        },
        verifyDownloaded(info) {
            verified = null;
            requireKeys();
            if (activeVersion !== info.version) throw new Error('Unexpected downloaded update');
            const payload = prepared.get(info.version);
            if (!payload) throw new Error('Missing verified release signature');
            assertUpdateMatches(payload, info, currentVersion);
            assertInstallerMatches(info.downloadedFile, payload);
            verified = {path: info.downloadedFile, payload};
        },
        install() {
            requireKeys();
            if (!verified || updater.installerPath !== verified.path) throw new Error('No verified installer is ready');
            // Re-read the cached file immediately before launch, including after "restart later".
            assertInstallerMatches(verified.path, verified.payload);
            updater.quitAndInstall();
        }
    };
}

module.exports = {createSignedUpdateGuard, fetchReleaseSignature};
