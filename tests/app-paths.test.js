const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const appPaths = require('../src/main/app-paths');
const pkg = require('../package.json');

test('application resources and development paths resolve from the project root', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(appPaths.root, root);
  assert.equal(pkg.main, 'src/main/main.js');
  assert.equal(pkg.build.appId, 'xyz.sk7z.webmapoverlay');
  for (const name of ['packageJson', 'icon', 'preload', 'config', 'keybindings', 'readme', 'licenses']) {
    assert.ok(fs.statSync(appPaths[name]).isFile(), `${name}: ${appPaths[name]}`);
  }
  assert.equal(appPaths.developmentUserData, path.join(root, 'user-data'));
  assert.equal(appPaths.nativeBuild, path.join(root, 'native', 'build', 'Release'));
  assert.equal(appPaths.watcher, path.join(root, 'build', 'bin', 'WebMapOverlayWatcher.exe'));
  for (const name of ['config', 'keybindings']) {
    assert.equal(new URL(pathToFileURL(appPaths[name])).protocol, 'file:');
    assert.match(fs.readFileSync(appPaths[name], 'utf8'), /window\.overlay/);
  }
  assert.match(fs.readFileSync(appPaths.preload, 'utf8'), /exposeInMainWorld\('overlay'/);
  for (const file of [pkg.main, 'src/main/app-paths.js', 'src/main/update-trusted-keys.json',
                      'src/preload.js', 'src/renderer/config.html', 'src/renderer/keybindings.html',
                      'assets/webmap_mini.png']) {
    assert.ok(pkg.build.files.includes(file), `${file} is not included in the application bundle`);
  }
});
