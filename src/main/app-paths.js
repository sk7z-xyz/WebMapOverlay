const path = require('path');

// This module lives in src/main both in development and inside app.asar.
const appRoot = path.resolve(__dirname, '../..');
const appPaths = Object.freeze({
  root: appRoot,
  packageJson: path.join(appRoot, 'package.json'),
  icon: path.join(appRoot, 'assets', 'webmap_mini.png'),
  preload: path.join(appRoot, 'src', 'preload.js'),
  config: path.join(appRoot, 'src', 'renderer', 'config.html'),
  keybindings: path.join(appRoot, 'src', 'renderer', 'keybindings.html'),
  readme: path.join(appRoot, 'README.txt'),
  licenses: path.join(appRoot, 'LICENSES.txt'),
  nativeBuild: path.join(appRoot, 'native', 'build', 'Release'),
  watcher: path.join(appRoot, 'build', 'bin', 'WebMapOverlayWatcher.exe'),
  developmentUserData: path.join(appRoot, 'user-data'),
});

module.exports = appPaths;
