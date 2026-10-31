const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {check, refresh} = require('../.github/scripts/installer-metadata');
const {installerName, hashInstallerSync} = require('../src/main/update-signature');

test('post-signing metadata and blockmap are rebuilt from the changed installer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-metadata-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const version = '1.1.2';
  const filename = installerName(version);
  const installer = path.join(dir, filename);
  fs.writeFileSync(installer, Buffer.alloc(1024 * 1024, 7));
  const before = hashInstallerSync(installer);
  fs.writeFileSync(path.join(dir, 'latest.yml'), yaml.dump({version,files:[{url:filename,...before}],path:filename,sha512:before.sha512}));
  fs.writeFileSync(installer + '.blockmap', 'old blockmap');
  check(dir, version);
  fs.appendFileSync(installer, Buffer.from('simulated signature'));
  await refresh(dir, version);
  const after = check(dir, version);
  assert.notEqual(after.sha512, before.sha512);
  assert.equal(after.size, before.size + Buffer.byteLength('simulated signature'));
  assert.notEqual(fs.readFileSync(installer + '.blockmap', 'utf8'), 'old blockmap');
});
