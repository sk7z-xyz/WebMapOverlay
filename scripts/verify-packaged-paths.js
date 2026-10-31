'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const asarPath = path.resolve(process.argv[2]);
const paths = require(path.join(asarPath, 'src/main/app-paths.js'));
const pkg = require(paths.packageJson);
assert.equal(paths.root, asarPath);
assert.equal(pkg.main, 'src/main/main.js');
for (const key of ['packageJson', 'icon', 'preload', 'config', 'keybindings']) {
  assert.ok(fs.statSync(paths[key]).isFile(), `Missing packaged resource: ${key}`);
}
assert.equal(path.join(asarPath, pkg.main), path.join(paths.root, 'src/main/main.js'));
console.log('Packaged application paths resolve successfully.');
