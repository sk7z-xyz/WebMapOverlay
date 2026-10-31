const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {EventEmitter} = require('node:events');
const Module = require('node:module');

// Exercise the real main-process window creation and IPC sender guard without
// starting Electron, a watcher, or a game process.
test('config and keybinding windows load the moved preload and accept only their own IPC frames', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-window-paths-'));
  t.after(() => fs.rmSync(userData, {recursive: true, force: true}));
  const paths = require('../src/main/app-paths');
  const app = new EventEmitter();
  Object.assign(app, {isPackaged: false, getPath: () => userData,
    requestSingleInstanceLock: () => true, whenReady: async () => {},
    quit() {}, disableHardwareAcceleration() {}, commandLine: {appendSwitch() {}}});
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.owner = this;
      this.webContents.mainFrame = {url: ''};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      windows.push(this);
      app.emit('web-contents-created', {}, this.webContents);
    }
    loadFile(file) { this.loadedFile = file; this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return false; }
    static fromWebContents(contents) { return contents.owner; }
  }
  const handlers = new Map();
  const electron = {app, BrowserWindow: FakeWindow, ipcMain: {handle: (name, handler) => handlers.set(name, handler)},
    dialog: {}, session: {defaultSession: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}}}};
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return electron;
      if (request === 'electron-updater') return {autoUpdater: null};
      return originalLoad.call(this, request, parent, isMain);
    };
    require('../src/main/main');
  } finally { Module._load = originalLoad; }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 1);
  const config = windows[0];
  assert.equal(config.loadedFile, paths.config);
  assert.equal(config.options.webPreferences.preload, paths.preload);
  const eventFor = window => ({sender: window.webContents, senderFrame: window.webContents.mainFrame});
  const initial = handlers.get('settings')(eventFor(config));
  assert.equal(initial.autoConnect, false);
  const saved = handlers.get('save-settings')(eventFor(config), {...initial, userName: 'test'});
  assert.equal(saved.userName, 'test');
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'))).userName, 'test');
  handlers.get('open-keybindings')(eventFor(config));
  assert.equal(windows.length, 2);
  const keybindings = windows[1];
  assert.equal(keybindings.loadedFile, paths.keybindings);
  assert.equal(keybindings.options.webPreferences.preload, paths.preload);
  assert.equal(handlers.get('settings')(eventFor(keybindings)).userName, 'test');
  assert.throws(() => handlers.get('settings')({sender: config.webContents, senderFrame: {url: pathToFileURL(paths.config).href}}), /許可/);
  config.webContents.mainFrame.url = 'https://example.invalid/';
  assert.throws(() => handlers.get('settings')(eventFor(config)), /許可/);
});
