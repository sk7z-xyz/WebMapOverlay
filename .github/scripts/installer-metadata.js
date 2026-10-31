const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {installerName, hashInstallerSync, assertUpdateMatches} = require('../../src/main/update-signature');
const {assertNoSymlinkPath} = require('../../src/main/path-safety');

function readMetadata(directory, version) {
    const filename = installerName(version);
    assertNoSymlinkPath(directory);
    const file = assertNoSymlinkPath(path.join(directory, 'latest.yml'));
    if (fs.statSync(file).size > 64 * 1024) throw new Error('Update metadata is too large');
    const metadata = yaml.load(fs.readFileSync(file, 'utf8'), {schema: yaml.JSON_SCHEMA});
    if (metadata?.version !== version || metadata.packages != null || metadata.files?.length !== 1 || metadata.files[0].url !== filename) {
        throw new Error('Unexpected installer metadata');
    }
    return {filename, metadata, file};
}

function check(directory, version) {
    const {filename, metadata} = readMetadata(directory, version);
    const payload = {schema: 'webmapoverlay.release.v1', version, filename,
        ...hashInstallerSync(path.join(directory, filename))};
    assertUpdateMatches(payload, metadata, '0.0.0');
    return payload;
}

async function refresh(directory, version) {
    const {filename, metadata, file} = readMetadata(directory, version);
    const installer = path.join(directory, filename);
    const actual = hashInstallerSync(installer);
    if (actual.sha512 === metadata.files[0].sha512) throw new Error('Installer has not changed after signing');
    const blockmap = assertNoSymlinkPath(`${installer}.blockmap`);
    if (!fs.statSync(blockmap).isFile()) throw new Error('Expected an existing blockmap');
    const {buildBlockMap} = require('app-builder-lib/out/targets/blockmap/blockmap');
    const temporaryBlockmap = assertNoSymlinkPath(`${blockmap}.tmp`, {allowMissing: true});
    const temporaryMetadata = assertNoSymlinkPath(`${file}.tmp`, {allowMissing: true});
    if (fs.existsSync(temporaryBlockmap) || fs.existsSync(temporaryMetadata)) throw new Error('Temporary outputs already exist');
    const computed = await buildBlockMap(installer, 'gzip', temporaryBlockmap);
    if (computed.size !== actual.size || computed.sha512 !== actual.sha512 || hashInstallerSync(installer).sha512 !== actual.sha512) {
        throw new Error('Installer changed during blockmap generation');
    }
    const updated = {...metadata, files: [{url: filename, sha512: actual.sha512, size: actual.size}], path: filename, sha512: actual.sha512};
    fs.writeFileSync(temporaryMetadata, yaml.dump(updated), {flag: 'wx'});
    fs.renameSync(temporaryBlockmap, blockmap);
    fs.renameSync(temporaryMetadata, file);
    return check(directory, version);
}

if (require.main === module) {
    const [command, directory, version, ...extra] = process.argv.slice(2);
    Promise.resolve().then(() => {
        if (extra.length || !directory || !['check', 'refresh'].includes(command)) throw new Error('Expected check|refresh directory version');
        return command === 'check' ? check(directory, version) : refresh(directory, version);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {check, refresh};
