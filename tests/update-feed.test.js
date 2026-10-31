const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {NsisUpdater} = require('electron-updater/out/NsisUpdater');
const {createSignedUpdateGuard, fetchReleaseSignature} = require('../src/main/signed-updates');
const {installerName, publicKeyDetails, signingData} = require('../src/main/update-signature');
const publish = require('../package.json').build.win.publish;

function responseBody(bytes) { return {getReader() { let done = false; return {async read() { if (done) return {done: true}; done = true; return {done: false, value: bytes}; }, async cancel() {}}; }, async cancel() {}}; }

function updater(t, version, provider) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webmapoverlay-feed-test-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const configPath = path.join(directory, 'app-update.yml');
    // JSON is also valid YAML; use the same publish options that the builder embeds.
    fs.writeFileSync(configPath, JSON.stringify({...provider, updaterCacheDirName: 'updater-cache'}));
    const instance = new NsisUpdater(null, {
        version, name: 'test', isPackaged: true, appUpdateConfigPath: configPath,
        userDataPath: directory, baseCachePath: directory,
        whenReady: async () => {}, onQuit() { throw new Error('must not install on quit'); }
    });
    instance.logger = null;
    instance.autoDownload = false;
    return instance;
}

function metadata(version, bytes) {
    const filename = installerName(version);
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    return {version, files: [{url: filename, sha512, size: bytes.length}], path: filename, sha512};
}

function requestUrl(options) {
    return new URL(options.path, `${options.protocol || 'https:'}//${options.hostname}`);
}

test('legacy 1.1.1 generic updater discovers and downloads the 2.0.0 installer from its fixed feed', async t => {
    const base = 'https://sk7z.xyz/files/webmapoverlay/';
    const legacy = updater(t, '1.1.1', {provider: 'generic', url: base});
    const bytes = Buffer.from('2.0.0 test installer; never executed');
    const info = metadata('2.0.0', bytes);
    const downloads = [];
    let downloaded;
    let differentialAttempted = false;
    legacy.autoDownload = true;
    legacy.addQuitHandler = () => {}; // Never launch a fixture installer.
    legacy.differentialDownloadInstaller = async () => { differentialAttempted = true; return true; }; // Model the full-download fallback.
    legacy.on('update-downloaded', event => { downloaded = event; });
    legacy.httpExecutor = {
        async request(options) {
            assert.equal(requestUrl(options).href.split('?')[0], `${base}latest.yml`);
            return JSON.stringify(info);
        },
        async download(url, destination) { downloads.push(url.href); fs.writeFileSync(destination, bytes); }
    };
    const result = await legacy.checkForUpdates();
    assert.equal(result.updateInfo.version, '2.0.0');
    await result.downloadPromise;
    assert.equal(differentialAttempted, true);
    assert.deepEqual(downloads, [`${base}${info.path}`]);
    assert.equal(downloaded.version, '2.0.0');
    assert.equal(fs.readFileSync(downloaded.downloadedFile, 'utf8'), bytes.toString());
    assert.equal(require('../package.json').build.appId, 'xyz.sk7z.webmapoverlay');
    assert.equal(require('../package.json').build.productName, 'WebMap Overlay');
});

test('2.0.0 loads the embedded public GitHub feed and verifies a signed 2.0.1 before install', async t => {
    assert.deepEqual(publish, {provider: 'github', owner: 'sk7z-xyz', repo: 'WebMapOverlay', private: false});
    const instance = updater(t, '2.0.0', publish);
    const bytes = Buffer.from('2.0.1 test installer; never executed');
    const info = metadata('2.0.1', bytes);
    const base = 'https://github.com/sk7z-xyz/WebMapOverlay';
    const requested = [];
    const downloads = [];
    instance.httpExecutor = {
        async request(options) {
            const url = requestUrl(options);
            requested.push(url.href);
            assert.equal(options.headers?.authorization, undefined);
            assert.equal(options.headers?.Authorization, undefined);
            if (url.href === `${base}/releases.atom`) {
                return `<feed><entry><link href="${base}/releases/tag/v2.0.1"/><title>2.0.1</title><content>Update</content></entry></feed>`;
            }
            if (url.href === `${base}/releases/latest`) {
                return JSON.stringify({tag_name: 'v2.0.1'});
            }
            assert.equal(url.href, `${base}/releases/download/v2.0.1/latest.yml`);
            return JSON.stringify(info);
        },
        async download(url, destination) {
            downloads.push(url.href);
            fs.writeFileSync(destination, bytes);
        }
    };
    const pair = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    const publicKey = pair.publicKey.export({type: 'spki', format: 'pem'});
    const details = publicKeyDetails(publicKey);
    const payload = {schema: 'webmapoverlay.release.v1', version: info.version,
        filename: info.path, size: bytes.length, sha512: info.sha512};
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const envelope = Buffer.from(JSON.stringify({schema: 'webmapoverlay.signature.v1', keyId: details.id,
        payload: payloadBytes.toString('base64'),
        signature: crypto.sign('sha256', signingData(payloadBytes), pair.privateKey).toString('base64')}));
    const guard = createSignedUpdateGuard(instance, {currentVersion: '2.0.0',
        keyDocument: {schema: 'webmapoverlay.trusted-keys.v1', keys: [{name: 'test', id: details.id, publicKey}]},
        fetchSignature: version => fetchReleaseSignature(version, async (url, options) => {
            assert.equal(url.href, `${base}/releases/download/v2.0.1/${info.path}.sig.json`);
            assert.equal(options.redirect, 'manual');
            return {status: 200, body: responseBody(envelope)};
        })
    });
    instance.on('update-downloaded', downloaded => guard.verifyDownloaded(downloaded));
    const result = await instance.checkForUpdates();
    assert.equal(result.updateInfo.version, '2.0.1');
    assert.equal(result.downloadPromise, null, 'discovery must not download an unverified release');
    await assert.rejects(guard.download(result.updateInfo), /not been verified/);
    assert.equal(downloads.length, 0);
    await guard.prepare(result.updateInfo);
    await guard.download(result.updateInfo);
    assert.deepEqual(downloads, [`${base}/releases/download/v2.0.1/${info.path}`]);
    assert.equal(requested.length, 3);
    let installed = false;
    instance.quitAndInstall = () => { installed = true; };
    guard.install();
    assert.equal(installed, true);
    assert.equal(instance.autoInstallOnAppQuit, false);
});

test('signature fetching follows allowed asset redirects and rejects other origins', async () => {
    const calls = [];
    const result = await fetchReleaseSignature('2.0.1', async url => {
        calls.push(url.href);
        if (calls.length === 1) return {status: 302, headers: {get: () => 'https://release-assets.githubusercontent.com/test/signature'}, body: {async cancel() {}}};
        return {status: 200, body: responseBody(Buffer.from('signature bytes'))};
    });
    assert.equal(result.toString(), 'signature bytes');
    assert.equal(calls.length, 2);
    for (const redirect of ['https://evil.example.invalid/signature', 'http://github.com/signature', 'https://user:password@github.com/signature']) {
        let requests = 0;
        await assert.rejects(fetchReleaseSignature('2.0.1', async () => {
            requests++;
            return {status: 302, headers: {get: () => redirect}, body: {async cancel() {}}};
        }), /Unexpected release signature URL/);
        assert.equal(requests, 1, 'a rejected redirect must not receive a request');
    }
});

test('missing release signatures and invalid versions stop signature retrieval', async () => {
    await assert.rejects(fetchReleaseSignature('2.0.1', async () => ({status: 404, body: {async cancel() {}}})), /404/);
    let requested = false;
    await assert.rejects(fetchReleaseSignature('../2.0.1', async () => { requested = true; }), /Invalid stable release version/);
    assert.equal(requested, false);
});


test('signature response size is limited while streaming', async () => {
    let cancelled = false;
    const body = {getReader() { let delivered = false; return {async read() { if (delivered) return {done: true}; delivered = true; return {done: false, value: Buffer.alloc(16385)}; }, async cancel() { cancelled = true; }}; }};
    await assert.rejects(fetchReleaseSignature('2.0.1', async () => ({status:200, body})), /too large/);
    assert.equal(cancelled, true);
});
