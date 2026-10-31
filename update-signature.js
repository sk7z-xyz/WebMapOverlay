const crypto = require('node:crypto');
const fs = require('node:fs');
const {assertNoSymlinkPath} = require('./path-safety');

const DOMAIN = Buffer.from('WebMapOverlay release signature v1\n', 'utf8');
const MAX_SIGNATURE_BYTES = 16 * 1024;

function requireStableVersion(version) {
    if (typeof version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
        throw new Error('Invalid stable release version');
    }
    return version;
}

function installerName(version) {
    return `WebMapOverlay-${requireStableVersion(version)}-Installer.exe`;
}

function decodeBase64(value, maxBytes) {
    if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('Invalid signature encoding');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('Invalid signature encoding');
    return bytes;
}

function publicKeyDetails(pem) {
    if (typeof pem !== 'string' || pem.length > 2048 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) {
        throw new Error('Expected a public SPKI PEM key');
    }
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
        throw new Error('Only ECDSA P-256 update keys are supported');
    }
    const der = key.export({type: 'spki', format: 'der'});
    return {
        key,
        id: crypto.createHash('sha256').update(der).digest('hex'),
        publicKey: key.export({type: 'spki', format: 'pem'}).toString()
    };
}

function loadTrustedKeys(document) {
    if (!document || document.schema !== 'webmapoverlay.trusted-keys.v1' || !Array.isArray(document.keys) || document.keys.length > 8) {
        throw new Error('Invalid update key configuration');
    }
    const keys = new Map();
    for (const entry of document.keys) {
        const details = publicKeyDetails(entry.publicKey);
        if (entry.id !== details.id || keys.has(entry.id)) throw new Error('Invalid or duplicate update key ID');
        keys.set(details.id, details.key);
    }
    return keys;
}

function validatePayload(payload) {
    if (!payload || payload.schema !== 'webmapoverlay.release.v1' || payload.filename !== installerName(payload.version) ||
        !Number.isSafeInteger(payload.size) || payload.size <= 0 || decodeBase64(payload.sha512, 64).length !== 64) {
        throw new Error('Invalid signed release manifest');
    }
    return payload;
}

function signingData(payloadBytes) {
    return Buffer.concat([DOMAIN, payloadBytes]);
}

function verifyEnvelope(raw, trustedKeys) {
    if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw, 'utf8');
    if (raw.length > MAX_SIGNATURE_BYTES) throw new Error('Release signature is too large');
    const envelope = JSON.parse(raw.toString('utf8'));
    if (!envelope || envelope.schema !== 'webmapoverlay.signature.v1' || !trustedKeys.has(envelope.keyId)) {
        throw new Error('Release was not signed by a trusted update key');
    }
    const payloadBytes = decodeBase64(envelope.payload, 4096);
    const signature = decodeBase64(envelope.signature, 80);
    if (!crypto.verify('sha256', signingData(payloadBytes), trustedKeys.get(envelope.keyId), signature)) {
        throw new Error('Invalid release signature');
    }
    return Object.freeze(validatePayload(JSON.parse(payloadBytes.toString('utf8'))));
}

function assertUpdateMatches(payload, info, currentVersion) {
    const current = requireStableVersion(currentVersion).split('.').map(Number);
    const next = requireStableVersion(info.version).split('.').map(Number);
    const firstDifferent = next.findIndex((value, index) => value !== current[index]);
    if (firstDifferent < 0 || next[firstDifferent] < current[firstDifferent]) throw new Error('Update must be newer than the installed version');
    if (info.version !== payload.version || !Array.isArray(info.files) || info.files.length !== 1 || info.packages != null) {
        throw new Error('Update metadata does not match the signed release');
    }
    const file = info.files[0];
    if (file.url !== payload.filename || file.sha512 !== payload.sha512 || file.size !== payload.size ||
        file.packageInfo != null || (info.path != null && info.path !== payload.filename) ||
        (info.sha512 != null && info.sha512 !== payload.sha512)) {
        throw new Error('Installer metadata does not match the signed release');
    }
}

// Use a handle for the entire read and reject links in every path component.
function hashInstallerSync(filePath) {
    assertNoSymlinkPath(filePath, {allowMissing: false});
    const fd = fs.openSync(filePath, 'r');
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile()) throw new Error('Installer is not a regular file');
        const hash = crypto.createHash('sha512');
        const chunk = Buffer.alloc(1024 * 1024);
        let length;
        while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, length));
        const after = fs.fstatSync(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error('Installer changed during verification');
        }
        return {size: after.size, sha512: hash.digest('base64')};
    } finally {
        fs.closeSync(fd);
    }
}

function assertInstallerMatches(filePath, payload) {
    const actual = hashInstallerSync(filePath);
    if (actual.size !== payload.size || actual.sha512 !== payload.sha512) throw new Error('Installer does not match the signed release');
}

module.exports = {
    MAX_SIGNATURE_BYTES, requireStableVersion, installerName, publicKeyDetails, loadTrustedKeys,
    validatePayload, signingData, verifyEnvelope, assertUpdateMatches, hashInstallerSync, assertInstallerMatches
};
