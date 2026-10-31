const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {NsisUpdater} = require('electron-updater/out/NsisUpdater');
const {createSignedUpdateGuard} = require('../signed-updates');
const {
    installerName, publicKeyDetails, loadTrustedKeys, signingData, verifyEnvelope,
    assertUpdateMatches, hashInstallerSync
} = require('../update-signature');

function fixture(t, version = '2.0.0') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webmapbridge-signature-test-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const pair = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    const pem = pair.publicKey.export({type: 'spki', format: 'pem'});
    const details = publicKeyDetails(pem);
    const keyDocument = {schema: 'webmapoverlay.trusted-keys.v1', keys: [{name: 'primary', id: details.id, publicKey: pem}]};
    const filename = installerName(version);
    const installer = path.join(directory, filename);
    const bytes = Buffer.from('test installer bytes; this is never executed');
    fs.writeFileSync(installer, bytes);
    const payload = {schema: 'webmapoverlay.release.v1', version, filename, ...hashInstallerSync(installer)};
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const envelope = {schema: 'webmapoverlay.signature.v1', keyId: details.id, payload: payloadBytes.toString('base64'),
        signature: crypto.sign('sha256', signingData(payloadBytes), pair.privateKey).toString('base64')};
    const info = {version, files: [{url: filename, sha512: payload.sha512, size: payload.size}], path: filename, sha512: payload.sha512};
    return {directory, installer, bytes, pair, keyDocument, payload, envelope, info};
}

test('accepts a pinned signature and rejects tampered payloads, signatures, unknown keys and oversized input', t => {
    const f = fixture(t);
    const keys = loadTrustedKeys(f.keyDocument);
    assert.deepEqual(verifyEnvelope(JSON.stringify(f.envelope), keys), f.payload);
    const altered = {...f.envelope, payload: Buffer.from(JSON.stringify({...f.payload, version: '9.0.0'})).toString('base64')};
    assert.throws(() => verifyEnvelope(JSON.stringify(altered), keys), /Invalid release signature/);
    const signature = Buffer.from(f.envelope.signature, 'base64');
    signature[signature.length - 1] ^= 1;
    assert.throws(() => verifyEnvelope(JSON.stringify({...f.envelope, signature: signature.toString('base64')}), keys));
    assert.throws(() => verifyEnvelope(JSON.stringify({...f.envelope, keyId: '0'.repeat(64)}), keys), /trusted/);
    assert.throws(() => verifyEnvelope(Buffer.alloc(16385), keys), /too large/);
    assert.throws(() => verifyEnvelope(JSON.stringify({...f.envelope, payload: `${f.envelope.payload}\n`}), keys), /encoding/);
});

test('binds update metadata to version, filename, size and hash, rejects traversal and downgrades', t => {
    const f = fixture(t);
    assertUpdateMatches(f.payload, f.info, '1.3.13');
    for (const version of ['2.0.0', '2.1.0', '9.0.0']) assert.throws(() => assertUpdateMatches(f.payload, f.info, version), /newer/);
    for (const url of ['../evil.exe', 'sub/file.exe', 'C:\\evil.exe', 'https://example.invalid/file.exe']) {
        assert.throws(() => assertUpdateMatches(f.payload, {...f.info, files: [{...f.info.files[0], url}]}, '1.3.13'));
    }
    for (const changes of [{sha512: Buffer.alloc(64).toString('base64')}, {size: f.payload.size + 1}, {packageInfo: {path: 'other.7z'}}]) {
        assert.throws(() => assertUpdateMatches(f.payload, {...f.info, files: [{...f.info.files[0], ...changes}]}, '1.3.13'));
    }
    assert.throws(() => assertUpdateMatches(f.payload, {...f.info, version: '3.0.0'}, '1.3.13'));
    assert.throws(() => assertUpdateMatches(f.payload, {...f.info, packages: {}}, '1.3.13'));
    for (const version of ['../2.0.0', '2.0.0/evil', '2.0.0-beta', '02.0.0']) assert.throws(() => installerName(version));
});

test('trusts a separately registered backup key and rejects invalid key configuration', t => {
    const primary = fixture(t);
    const backup = fixture(t);
    const document = {...primary.keyDocument, keys: [...primary.keyDocument.keys, {...backup.keyDocument.keys[0], name: 'backup'}]};
    assert.deepEqual(verifyEnvelope(JSON.stringify(backup.envelope), loadTrustedKeys(document)), backup.payload);
    assert.throws(() => verifyEnvelope(JSON.stringify(backup.envelope), loadTrustedKeys(primary.keyDocument)), /trusted/);
    assert.throws(() => loadTrustedKeys({...document, keys: [document.keys[0], document.keys[0]]}), /duplicate/);
    assert.throws(() => publicKeyDetails(primary.pair.privateKey.export({type: 'pkcs8', format: 'pem'})), /public/);
});

test('without registered keys no update can be prepared, downloaded or installed', async () => {
    const updater = {downloadUpdate() { throw new Error('must not download'); }, quitAndInstall() { throw new Error('must not install'); }};
    const guard = createSignedUpdateGuard(updater, {keyDocument: {schema: 'webmapoverlay.trusted-keys.v1', keys: []}, currentVersion: '1.3.13'});
    assert.equal(guard.isConfigured(), false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    await assert.rejects(guard.prepare({version: '2.0.0'}), /未登録/);
    await assert.rejects(guard.download({version: '2.0.0'}), /未登録/);
    assert.throws(() => guard.install(), /未登録/);
});

test('real NSIS download and cache reuse are verified; file changes before install are rejected', async t => {
    const f = fixture(t);
    const configPath = path.join(f.directory, 'app-update.yml');
    fs.writeFileSync(configPath, 'updaterCacheDirName: updater-cache\n');
    let quitHandlers = 0;
    const updater = new NsisUpdater(null, {
        version: '1.3.13', name: 'test', isPackaged: true, appUpdateConfigPath: configPath,
        userDataPath: f.directory, baseCachePath: f.directory,
        whenReady: async () => {}, onQuit() { quitHandlers++; }
    });
    updater.logger = null;
    let downloads = 0;
    updater.httpExecutor = {async download(url, destination) { downloads++; fs.writeFileSync(destination, f.bytes); }};
    updater.updateInfoAndProvider = {info: f.info, provider: {
        resolveFiles: () => [{url: new URL(`https://example.invalid/${f.payload.filename}`), info: f.info.files[0]}],
        get fileExtraDownloadHeaders() { return null; }
    }};
    const guard = createSignedUpdateGuard(updater, {keyDocument: f.keyDocument, currentVersion: '1.3.13',
        fetchSignature: async () => JSON.stringify(f.envelope)});
    let checked = 0;
    updater.on('update-downloaded', info => { guard.verifyDownloaded(info); checked++; });
    await guard.prepare(f.info);
    await guard.download(f.info);
    assert.equal(downloads, 1);
    assert.equal(checked, 1);
    assert.equal(quitHandlers, 0, 'electron-updater must not register an unchecked install on quit');
    await guard.download(f.info);
    assert.equal(downloads, 1, 'second request uses electron-updater cache');
    assert.equal(checked, 2, 'cached update must still pass our verification');
    let installs = 0;
    updater.quitAndInstall = () => { installs++; };
    guard.install();
    assert.equal(installs, 1);
    const cached = updater.installerPath;
    fs.writeFileSync(cached, Buffer.alloc(f.bytes.length, 65));
    assert.throws(() => guard.install(), /does not match/);
    assert.equal(installs, 1);
    await assert.rejects(guard.download(f.info), /does not match/);
    assert.throws(() => guard.install(), /No verified installer/);
});

test('rejects installer symlinks and Windows junctions', t => {
    const f = fixture(t);
    const link = path.join(f.directory, 'linked');
    fs.symlinkSync(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => hashInstallerSync(path.join(link, f.payload.filename)), /links|junctions/);
});
