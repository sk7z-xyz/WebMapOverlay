const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  settings: () => ipcRenderer.invoke('settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  start: (settings, mode = 'safe') => ipcRenderer.invoke('start-overlay', settings, mode),
  stop: () => ipcRenderer.invoke('stop-overlay'),
  loadSelectionLists: () => ipcRenderer.invoke('load-selection-lists'),
  status: () => ipcRenderer.invoke('overlay-status'),
  running: () => ipcRenderer.invoke('overlay-running'),
  diagnostics: () => ipcRenderer.invoke('overlay-diagnostics'),
  setStormworksLaunch: (enabled) => ipcRenderer.invoke('set-stormworks-launch', enabled),
  stormworksLaunchStatus: () => ipcRenderer.invoke('stormworks-launch-status'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  showReadme: () => ipcRenderer.invoke('show-readme'),
  showLicenses: () => ipcRenderer.invoke('show-licenses'),
  openKeybindings: () => ipcRenderer.invoke('open-keybindings'),
  closeKeybindings: () => ipcRenderer.invoke('close-keybindings'),
});
