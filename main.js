const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const { pathToFileURL } = require('url');
const { createSignedUpdateGuard } = require('./signed-updates');
const { assertNoSymlinkPath } = require('./path-safety');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const packageJson = require(path.join(__dirname, 'package.json'));
const windowTrackerScript = require('./window-tracker-script');
const nativeBridge = require('./native-bridge');
const { parseTrackerStatus } = require('./tracker-status');
const {
  DEFAULT_MAP_ZOOM,
  DEFAULT_OVERLAY_RATIO,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  normalizeMapZoom,
  normalizeOverlayRatio,
} = require('./overlay-settings');

let autoUpdater;
try { ({ autoUpdater } = require('electron-updater')); }
catch { autoUpdater = null; }

const defaultUrl = 'https://webmap.sk7z.xyz/';
const updateFeed = { provider: 'github', owner: 'sk7z-xyz', repo: 'WebMapOverlay', private: false };
const signedUpdates = autoUpdater ? createSignedUpdateGuard(autoUpdater, {keyDocument: require('./update-trusted-keys.json'), currentVersion: packageJson.version}) : null;
const appIconPath = path.join(__dirname, 'webmap_mini.png');
const appTitle = `WebMap Overlay v${packageJson.version}`;
const stormworksLaunchTaskName = 'WebMap Overlay - Stormworks Launcher';
const startedByStormworks = process.argv.includes('--autostart');
const defaultKeyBindings = Object.freeze({
  toggle: 'NonConvert',
  spot: 'KeyQ',
  zoomIn: 'KeyZ',
  zoomOut: 'KeyX',
  reload: 'F5',
  sizeIncrease: 'BracketRight',
  sizeDecrease: 'BracketLeft',
  opacityIncrease: 'PageUp',
  opacityDecrease: 'PageDown',
  mouseModifier: 'NonConvert',
});
// インストーラー版でも書き込み可能なユーザーデータ領域に保存する。
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let configWindow;
let keybindingsWindow;
let readmeWindow;
let overlayWindow;
let injectionOverlayWindow;
let trackerProcess;
let overlayVisible = true;
let overlayRatio = DEFAULT_OVERLAY_RATIO;
let overlayOpacity = 0.90;
let overlayAnchor = 'bottom-left';
let overlayMapZoom = DEFAULT_MAP_ZOOM;
let lastGameRect = null;
let isQuitting = false;
let overlaySettings = null;
let currentHostUserName = '';
let hostPollTimer = null;
let hostPollAbortController = null;
let hostPollInFlight = false;
let hostPollFailureCount = 0;
let updateCheckTimer = null;
let autoUpdaterInitialized = false;
let pendingUpdateInfo = null;
let pendingUpdatePromptInFlight = false;
let overlaySettingsSaveTimer = null;
let gameActive = false;
let stormworksWindowAvailable = false;
let stormworksSeenInCurrentSession = false;
let trackerRestartTimer = null;
let trackerRestartAttempts = 0;
let lastOverlayRaiseAt = 0;
let overlayPageReady = false;
let overlayNavigationId = 0;
let blankOverlayCheckTimer = null;
let blankOverlayCheckInFlight = false;
let blankOverlayCount = 0;
let overlayReloadTimer = null;
let overlayDiagnostics = {
  displayReason: 'stopped',
  apiStatus: '未確認',
  injectionStatus: '停止',
  injectionDetail: '',
  detail: '',
  updatedAt: Date.now(),
};
let overlayMode = 'safe';
let currentStormworksPid = 0;
let lastInjectedPid = 0;
let injectionAttemptInFlight = false;
let injectionMonitorTimer = null;
let injectionNativeReady = false;
let injectionPageReady = false;
let injectionCaptureWidth = 512;
let injectionCaptureHeight = 512;
let injectionNavigationId = 0;
let injectionRequestedByUser = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function loadSettings() {
  try {
    assertNoSymlinkPath(settingsPath);
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      ...saved,
      autoConnect: Boolean(saved.autoConnect),
      launchWithStormworks: Boolean(saved.launchWithStormworks),
      autoExitOnStormworksExit: Boolean(saved.autoExitOnStormworksExit),
      hardwareAcceleration: typeof saved.hardwareAcceleration === 'boolean' ? saved.hardwareAcceleration : true,
      overlayOpacity: normalizeOpacity(saved.overlayOpacity),
      overlayRatio: normalizeOverlayRatio(saved.overlayRatio),
      mapZoom: normalizeMapZoom(saved.mapZoom),
      overlayAnchor: normalizeOverlayAnchor(saved.overlayAnchor),
      overlayMode: normalizeOverlayMode(saved.overlayMode),
      injectionWarningAccepted: Boolean(saved.injectionWarningAccepted),
      injectionAutoStartAllowed: Boolean(saved.injectionAutoStartAllowed),
      keyBindings: normalizeKeyBindings(saved),
    };
  }
  catch {
    return {
      url: defaultUrl, hostUserName: '', userName: '',
      autoConnect: false, overlayOpacity: 0.90,
      overlayRatio: DEFAULT_OVERLAY_RATIO,
      mapZoom: DEFAULT_MAP_ZOOM,
      hardwareAcceleration: true,
      launchWithStormworks: false,
      autoExitOnStormworksExit: false,
      overlayMode: 'safe',
      injectionWarningAccepted: false,
      injectionAutoStartAllowed: false,
      overlayAnchor: 'bottom-left', keyBindings: { ...defaultKeyBindings },
    };
  }
}

function normalizeOverlayMode(value) {
  return value === 'injection' ? 'injection' : 'safe';
}

function normalizeOverlayAnchor(value) {
  return ['bottom-left', 'top-left', 'top-right', 'bottom-right'].includes(value) ? value : 'bottom-left';
}

function normalizeOpacity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0.20, Math.min(1.0, parsed)) : 0.90;
}

function normalizeKeyBindings(settings = {}) {
  const bindings = { ...defaultKeyBindings, ...(settings.keyBindings || {}) };
  if (!settings.keyBindings?.toggle && settings.keyBinding) bindings.toggle = settings.keyBinding;
  for (const action of Object.keys(bindings)) {
    if (bindings[action] !== null && typeof bindings[action] !== 'string') bindings[action] = defaultKeyBindings[action];
  }
  // 表示切替とホイール調整キーだけは、短押し／押下中で役割が異なるため共用する。
  const accepted = [];
  for (const action of Object.keys(defaultKeyBindings)) {
    const code = bindings[action];
    if (!code) continue;
    const conflicts = accepted.filter((other) => bindings[other] === code && !canShareKeyBinding(action, other));
    if (conflicts.length > 0) bindings[action] = null;
    else accepted.push(action);
  }
  return bindings;
}

function canShareKeyBinding(first, second) {
  return (first === 'toggle' && second === 'mouseModifier') || (first === 'mouseModifier' && second === 'toggle');
}

function bindingVirtualKey(code) {
  const specialKeys = {
    NonConvert: 0x1D, Convert: 0x1C, AltLeft: 0xA4, AltRight: 0xA5,
    ControlLeft: 0xA2, ControlRight: 0xA3, ShiftLeft: 0xA0, ShiftRight: 0xA1,
    MetaLeft: 0x5B, MetaRight: 0x5C, Space: 0x20, Tab: 0x09, CapsLock: 0x14,
    Enter: 0x0D, Backspace: 0x08, Escape: 0x1B, Insert: 0x2D, Delete: 0x2E,
    Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    Backquote: 0xC0, Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB,
    BracketRight: 0xDD, Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE,
    Comma: 0xBC, Period: 0xBE, Slash: 0xBF,
    NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
    NumpadDecimal: 0x6E, NumpadDivide: 0x6F,
  };
  if (!code) return 0;
  if (specialKeys[code]) return specialKeys[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  const numpadKey = /^Numpad([0-9])$/.exec(code);
  if (numpadKey) return 0x60 + Number(numpadKey[1]);
  const functionKey = /^F(\d{1,2})$/.exec(code);
  if (functionKey && Number(functionKey[1]) >= 1 && Number(functionKey[1]) <= 12) return 0x6F + Number(functionKey[1]);
  return 0;
}

function saveSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('設定が正しくありません。');
  const url = new URL(String(settings.url || defaultUrl).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接続先にはHTTPまたはHTTPSのURLを指定してください。');
  for (const field of ['url', 'hostUserName', 'userName']) {
    if (settings[field] != null && (typeof settings[field] !== 'string' || settings[field].length > 2048)) throw new Error('設定の入力値が正しくありません。');
  }
  const existing = loadSettings();
  const saved = {
    url: String(settings.url || defaultUrl).trim(),
    hostUserName: String(settings.hostUserName || '').trim(),
    userName: String(settings.userName || '').trim(),
    developerMode: Boolean(settings.developerMode),
    autoConnect: Boolean(settings.autoConnect),
    hardwareAcceleration: typeof settings.hardwareAcceleration === 'boolean'
      ? settings.hardwareAcceleration
      : existing.hardwareAcceleration,
    launchWithStormworks: Boolean(settings.launchWithStormworks),
    autoExitOnStormworksExit: Boolean(settings.autoExitOnStormworksExit),
    overlayOpacity: normalizeOpacity(settings.overlayOpacity ?? existing.overlayOpacity),
    overlayRatio: normalizeOverlayRatio(settings.overlayRatio ?? existing.overlayRatio),
    mapZoom: normalizeMapZoom(settings.mapZoom ?? existing.mapZoom),
    overlayAnchor: normalizeOverlayAnchor(settings.overlayAnchor ?? existing.overlayAnchor),
    overlayMode: normalizeOverlayMode(settings.overlayMode ?? existing.overlayMode),
    injectionWarningAccepted: Boolean(settings.injectionWarningAccepted ?? existing.injectionWarningAccepted),
    injectionAutoStartAllowed: Boolean(settings.injectionAutoStartAllowed ?? existing.injectionAutoStartAllowed),
    keyBindings: normalizeKeyBindings({ ...existing, ...settings }),
  };
  assertNoSymlinkPath(path.dirname(settingsPath), {allowMissing: true});
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  assertNoSymlinkPath(settingsPath, {allowMissing: true});
  fs.writeFileSync(settingsPath, JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

function nativeResourcePath(name) {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, name),
    path.join(__dirname, 'native', 'build', 'Release', name),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function injectorPath() { return nativeResourcePath('WebMapOverlayInjector.exe'); }
function hookDllPath() { return nativeResourcePath('WebMapOverlayHook.dll'); }

function activeOverlayContents() {
  const window = overlayMode === 'injection' ? injectionOverlayWindow : overlayWindow;
  return window && !window.isDestroyed() ? window.webContents : null;
}

// DLL方式はStormworksのバックバッファへ直接描画する。安全版と同じく、
// Stormworksが前面のときだけ共有制御を有効にする。
function injectionRenderAllowed() {
  return overlayMode === 'injection'
    && injectionPageReady
    && overlayVisible
    && Boolean(currentHostUserName)
    && stormworksWindowAvailable
    && lastInjectedPid === currentStormworksPid;
}

function updateInjectionControl(visible = false) {
  if (overlayMode !== 'injection' || !injectionNativeReady) return;
  try {
    nativeBridge.control(Boolean(visible), overlayRatio, overlayOpacity, {
      'bottom-left': 0,
      'top-left': 1,
      'top-right': 2,
      'bottom-right': 3,
    }[overlayAnchor] ?? 0, Boolean(visible));
  } catch (error) {
    console.error(`injection control update failed: ${error.message}`);
  }
}

function setInjectionStatus(status, detail = '') {
  overlayDiagnostics = {
    ...overlayDiagnostics,
    injectionStatus: status,
    injectionDetail: detail,
    updatedAt: Date.now(),
  };
}

function setStormworksState(source, available, active, pid = 0) {
  const nextAvailable = Boolean(available);
  const nextActive = Boolean(active);
  const numericPid = Number(pid);
  const nextPid = Number.isFinite(numericPid) && numericPid > 0 ? Math.trunc(numericPid) : 0;
  const changed = stormworksWindowAvailable !== nextAvailable
    || gameActive !== nextActive
    || currentStormworksPid !== nextPid;
  stormworksWindowAvailable = nextAvailable;
  gameActive = nextActive;
  currentStormworksPid = nextPid;
  if (changed) {
    console.log(`[stormworks-state] source=${source} available=${nextAvailable} active=${nextActive} pid=${nextPid}`);
  }
}

// GPU の利用可否は BrowserWindow 作成前、かつ Electron 起動直後に決める必要がある。
// 未設定時は有効とし、明示的に無効化した既存設定だけを維持する。
const startupSettings = loadSettings();
overlayRatio = startupSettings.overlayRatio;
overlayMapZoom = startupSettings.mapZoom;
overlayOpacity = startupSettings.overlayOpacity;
overlayAnchor = startupSettings.overlayAnchor;
if (!startupSettings.hardwareAcceleration) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

async function changeWebMapZoom(direction) {
  const contents = activeOverlayContents();
  if (!contents) return;
  try {
    const nextZoom = await contents.executeJavaScript(`
      (() => {
        if (typeof updateMapZoom !== 'function' || typeof zoomLevel !== 'number') return null;
        const nextZoom = Math.min(Math.max(${MIN_MAP_ZOOM}, zoomLevel * Math.pow(1.15, ${direction})), ${MAX_MAP_ZOOM});
        updateMapZoom(nextZoom);
        return zoomLevel;
      })();
    `);
    if (nextZoom === null || nextZoom === undefined) return;
    overlayMapZoom = normalizeMapZoom(nextZoom);
    scheduleOverlaySettingsSave();
  } catch (error) {
    console.error(`zoom key failed: ${error.message}`);
  }
}

async function restoreWebMapZoom(contents) {
  if (!contents || contents.isDestroyed() || !overlaySettings) return;
  const requestedZoom = normalizeMapZoom(overlayMapZoom);
  try {
    const appliedZoom = await contents.executeJavaScript(`
      (() => {
        if (typeof updateMapZoom !== 'function' || typeof zoomLevel !== 'number') return null;
        updateMapZoom(${requestedZoom});
        return zoomLevel;
      })();
    `);
    if (appliedZoom !== null && appliedZoom !== undefined) {
      overlayMapZoom = normalizeMapZoom(appliedZoom);
    }
  } catch (error) {
    console.warn(`saved WebMap zoom restore failed: ${error.message}`);
  }
}

function setOverlayDiagnostic(displayReason, detail = '') {
  overlayDiagnostics = { ...overlayDiagnostics, displayReason, detail, updatedAt: Date.now() };
}

function hideOverlay(displayReason, detail = '') {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  updateInjectionControl(false);
  setOverlayDiagnostic(displayReason, detail);
}

function stopBlankOverlayCheck() {
  if (blankOverlayCheckTimer) clearTimeout(blankOverlayCheckTimer);
  blankOverlayCheckTimer = null;
  blankOverlayCheckInFlight = false;
  blankOverlayCount = 0;
}

function isMostlyWhiteImage(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  if (!size.width || !size.height || bitmap.length < size.width * size.height * 4) return false;
  let whitePixels = 0;
  let samples = 0;
  const sampleCount = 9;
  for (let yIndex = 0; yIndex < sampleCount; yIndex += 1) {
    const y = Math.min(size.height - 1, Math.floor((yIndex + 0.5) * size.height / sampleCount));
    for (let xIndex = 0; xIndex < sampleCount; xIndex += 1) {
      const x = Math.min(size.width - 1, Math.floor((xIndex + 0.5) * size.width / sampleCount));
      const offset = (y * size.width + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      if (red >= 245 && green >= 245 && blue >= 245) whitePixels += 1;
      samples += 1;
    }
  }
  return samples > 0 && whitePixels / samples >= 0.96;
}

async function checkForBlankOverlay() {
  if (blankOverlayCheckInFlight || !overlayWindow || overlayWindow.isDestroyed()
    || !overlayPageReady || !overlayVisible || !gameActive || !currentHostUserName) return;
  if (!overlayWindow.isVisible()) return;
  blankOverlayCheckInFlight = true;
  try {
    const image = await overlayWindow.webContents.capturePage();
    if (isMostlyWhiteImage(image)) {
      blankOverlayCount += 1;
      if (blankOverlayCount >= 2) {
        console.warn('WebMap overlay appears blank; reloading the page.');
        blankOverlayCount = 0;
        scheduleOverlayReload(250, '白画面を検出したため再読み込みしています');
      }
    } else {
      blankOverlayCount = 0;
    }
  } catch (error) {
    console.error(`blank overlay check failed: ${error.message}`);
  } finally {
    blankOverlayCheckInFlight = false;
  }
}

function startBlankOverlayCheck() {
  if (blankOverlayCheckTimer || !overlaySettings) return;
  blankOverlayCheckTimer = setTimeout(async () => {
    blankOverlayCheckTimer = null;
    await checkForBlankOverlay();
    if (overlaySettings && overlayWindow && !overlayWindow.isDestroyed()) startBlankOverlayCheck();
  }, 3000);
}

function scheduleOverlayReload(delay = 1000, detail = 'WebMapを再読み込みしています') {
  if (overlayReloadTimer || !overlaySettings || !currentHostUserName || !stormworksWindowAvailable) return;
  overlayReloadTimer = setTimeout(() => {
    overlayReloadTimer = null;
    const window = overlayMode === 'injection' ? injectionOverlayWindow : overlayWindow;
    if (!overlaySettings || !currentHostUserName || !window || window.isDestroyed()) return;
    loadOverlayPage(currentHostUserName, 'page-loading', detail);
  }, Math.max(0, delay));
}

function reloadOverlayPage() {
  const window = overlayMode === 'injection' ? injectionOverlayWindow : overlayWindow;
  if (!window || window.isDestroyed() || !currentHostUserName || !stormworksWindowAvailable) return;
  if (overlayReloadTimer) clearTimeout(overlayReloadTimer);
  overlayReloadTimer = null;
  blankOverlayCount = 0;
  loadOverlayPage(currentHostUserName, 'page-loading', '手動更新');
}

function destroyOverlayWindow(displayReason, detail = '') {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = undefined;
  if (injectionOverlayWindow && !injectionOverlayWindow.isDestroyed()) injectionOverlayWindow.destroy();
  injectionOverlayWindow = undefined;
  injectionPageReady = false;
  updateInjectionControl(false);
  overlayNavigationId += 1;
  injectionNavigationId += 1;
  stopBlankOverlayCheck();
  if (overlayReloadTimer) clearTimeout(overlayReloadTimer);
  overlayReloadTimer = null;
  overlayPageReady = false;
  lastGameRect = null;
  lastOverlayRaiseAt = 0;
  setOverlayDiagnostic(displayReason, detail);
}

function keepOverlayAboveGame(force = false) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const now = Date.now();
  if (!force && now - lastOverlayRaiseAt < 500) return;
  try {
    // Stormworksが後から自身を前面へ移動しても、フォーカスを奪わず重なり順だけ戻す。
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.moveTop();
    lastOverlayRaiseAt = now;
  } catch (error) {
    console.error(`overlay z-order update failed: ${error.message}`);
  }
}

function scheduleOverlaySettingsSave() {
  if (!overlaySettings) return;
  if (overlaySettingsSaveTimer) clearTimeout(overlaySettingsSaveTimer);
  overlaySettingsSaveTimer = setTimeout(() => {
    overlaySettingsSaveTimer = null;
    if (!overlaySettings) return;
    overlaySettings = saveSettings({ ...overlaySettings, overlayRatio, overlayOpacity, mapZoom: overlayMapZoom });
  }, 350);
}

function scheduleOpacitySave() {
  scheduleOverlaySettingsSave();
}

function flushOverlaySettingsSave() {
  if (!overlaySettingsSaveTimer) return;
  clearTimeout(overlaySettingsSaveTimer);
  overlaySettingsSaveTimer = null;
  if (overlaySettings) {
    overlaySettings = saveSettings({ ...overlaySettings, overlayRatio, overlayOpacity, mapZoom: overlayMapZoom });
  }
}

function loadOverlayPage(hostUserName, hiddenReason = 'player-not-found', detail = '') {
  const window = overlayMode === 'injection' ? injectionOverlayWindow : overlayWindow;
  if (!window || window.isDestroyed() || !overlaySettings) return;
  if (!hostUserName) {
    currentHostUserName = '';
    hideOverlay(hiddenReason);
    return;
  }
  const baseUrl = new URL(overlaySettings.url || defaultUrl);
  const targetUrl = new URL(`/${encodeURIComponent(hostUserName)}`, baseUrl.origin);
  targetUrl.searchParams.set('mini_map', 'true');
  if (overlaySettings.userName) targetUrl.searchParams.set('steam_64', overlaySettings.userName);
  const navigationId = overlayMode === 'injection' ? ++injectionNavigationId : ++overlayNavigationId;
  if (overlayMode === 'injection') injectionPageReady = false;
  else overlayPageReady = false;
  blankOverlayCount = 0;
  currentHostUserName = hostUserName;
  hideOverlay('page-loading', detail || `ホスト: ${hostUserName}`);
  void window.loadURL(targetUrl.toString()).catch((error) => {
    const navigationMatches = overlayMode === 'injection'
      ? navigationId === injectionNavigationId
      : navigationId === overlayNavigationId;
    if (!navigationMatches || !window || window.isDestroyed()) return;
    console.error(`WebMap page load failed: ${error.message}`);
    hideOverlay('page-error', 'WebMapの読み込みに失敗しました。');
    scheduleOverlayReload(1000, '読み込み失敗後に再試行しています');
  });
}

// Ground mode中のスポット要求。判定と視線位置の解決はサーバー側で行うため、
// Overlayからは現在のホストと選択中Steam IDだけを送る。
async function requestUnknownTankSpot() {
  const settings = overlaySettings;
  const hostUserName = currentHostUserName;
  if (!settings || !hostUserName || !settings.userName) return;
  try {
    const baseUrl = new URL(settings.url || defaultUrl);
    const endpoint = new URL('/client/post/', baseUrl.origin);
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        mode: 'unknown_tank_spot',
        host_user_name: hostUserName,
        steam_id64: String(settings.userName),
      }),
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* 本文なしの旧サーバー互換 */ }
    if (!response.ok) {
      const reason = payload?.error || 'unknown_error';
      const detail = payload?.detail ? ` detail=${JSON.stringify(payload.detail)}` : '';
      console.warn(`UnknownTank spot request rejected (${response.status}): ${reason}${detail}`);
    }
  } catch (error) {
    console.warn(`UnknownTank spot request failed: ${error.message}`);
  }
}

async function refreshOverlayHost() {
  if (!overlaySettings || hostPollInFlight) return;
  if (!overlaySettings.userName) {
    currentHostUserName = '';
    overlayDiagnostics = { ...overlayDiagnostics, apiStatus: '未接続（ユーザー未選択）', updatedAt: Date.now() };
    setOverlayDiagnostic('player-not-selected', 'あなたのユーザー名を選択してください');
    return;
  }
  const requestedSettings = overlaySettings;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  hostPollAbortController = controller;
  hostPollInFlight = true;
  try {
    const baseUrl = new URL(requestedSettings.url || defaultUrl);
    const endpoint = new URL('/api/webmap/player-hosts', baseUrl.origin);
    endpoint.searchParams.set('steam_id64', requestedSettings.userName);
    const response = await fetch(endpoint.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`host lookup failed (${response.status})`);
    const payload = await response.json();
    // 停止・再接続後に届いた古い応答は現在の状態へ反映しない。
    if (overlaySettings !== requestedSettings) return;
    hostPollFailureCount = 0;
    const players = Array.isArray(payload.players) ? payload.players : [];
    const ownSteamId = String(requestedSettings.userName);
    const ownPlayers = players.filter((player) => String(player.steam_id64 || '') === ownSteamId);
    // APIが正常応答でも本人が見つからない場合は、以前のホストを表示し続けない。
    if (ownPlayers.length === 0) {
      overlayDiagnostics = { ...overlayDiagnostics, apiStatus: '未接続（プレイヤー情報なし）', updatedAt: Date.now() };
      loadOverlayPage('', 'player-not-found');
      updateInjectionControl(false);
      return;
    }
    const online = ownPlayers.find((player) => player.is_online);
    if (!online) {
      currentHostUserName = '';
      overlayDiagnostics = { ...overlayDiagnostics, apiStatus: '未接続（オフライン）', updatedAt: Date.now() };
      destroyOverlayWindow('player-offline');
      updateInjectionControl(false);
    } else if (!online.host_user_name) {
      overlayDiagnostics = { ...overlayDiagnostics, apiStatus: '未接続（接続先を確認できません）', updatedAt: Date.now() };
      loadOverlayPage('', 'player-host-unknown');
      updateInjectionControl(false);
    } else {
      overlayDiagnostics = { ...overlayDiagnostics, apiStatus: 'オンライン', updatedAt: Date.now() };
      // Stormworks未検出中は接続先だけ記憶する。WebMap rendererの生成は、
      // ウィンドウを検出した updateOverlayBounds まで遅延させる。
      if (!stormworksWindowAvailable) {
        currentHostUserName = online.host_user_name;
        setOverlayDiagnostic('game-window-not-found', 'Stormworks は起動していません');
        return;
      }
      const activeWindow = overlayMode === 'injection' ? injectionOverlayWindow : overlayWindow;
      if (!activeWindow || activeWindow.isDestroyed()) createOverlay(overlaySettings, overlayMode);
      if (online.host_user_name !== currentHostUserName) loadOverlayPage(online.host_user_name);
    }
  } catch (error) {
    if (overlaySettings !== requestedSettings) return;
    hostPollFailureCount += 1;
    const detail = controller.signal.aborted ? 'API応答が4.5秒以内にありません' : '接続先を確認できません';
    console.error(`host lookup failed: ${error.message}`);
    overlayDiagnostics = { ...overlayDiagnostics, apiStatus: `未接続（確認できません: ${hostPollFailureCount}/3）`, updatedAt: Date.now() };
    // 一時的な通信失敗では直前の表示を維持し、連続失敗時だけ古い地図を隠す。
    if (hostPollFailureCount >= 3) {
      currentHostUserName = '';
      hideOverlay('api-unavailable', detail);
    }
  } finally {
    clearTimeout(timeout);
    if (hostPollAbortController === controller) hostPollAbortController = null;
    hostPollInFlight = false;
  }
}

async function pollOverlayHost() {
  hostPollTimer = null;
  if (!overlaySettings) return;
  // 設定変更で直前の問い合わせを中断した場合、その完了を待って新しい設定を確認する。
  if (hostPollInFlight) {
    hostPollTimer = setTimeout(pollOverlayHost, 100);
    return;
  }
  await refreshOverlayHost();
  if (overlaySettings && !hostPollTimer) hostPollTimer = setTimeout(pollOverlayHost, 5000);
}

function startHostPolling(immediate = false) {
  if (!overlaySettings) return;
  if (immediate) {
    if (hostPollTimer) clearTimeout(hostPollTimer);
    hostPollTimer = null;
    if (hostPollAbortController) hostPollAbortController.abort();
    hostPollTimer = setTimeout(pollOverlayHost, hostPollInFlight ? 100 : 0);
    return;
  }
  if (hostPollTimer || hostPollInFlight) return;
  hostPollTimer = setTimeout(pollOverlayHost, 0);
}

function stopHostPolling() {
  if (hostPollTimer) clearTimeout(hostPollTimer);
  hostPollTimer = null;
  if (hostPollAbortController) hostPollAbortController.abort();
  hostPollAbortController = null;
  hostPollFailureCount = 0;
}

function scheduleInjectionAttempt(delay = 0) {
  if (injectionMonitorTimer) clearTimeout(injectionMonitorTimer);
  if (overlayMode !== 'injection' || !overlaySettings || isQuitting) return;
  injectionMonitorTimer = setTimeout(() => {
    injectionMonitorTimer = null;
    void attemptInjection();
  }, Math.max(0, delay));
}

async function attemptInjection() {
  if (overlayMode !== 'injection' || !overlaySettings || isQuitting || injectionAttemptInFlight) return;
  if (!currentStormworksPid) {
    setInjectionStatus('待機中', 'Stormworksの起動を待っています');
    scheduleInjectionAttempt(1000);
    return;
  }
  if (!stormworksWindowAvailable) {
    setInjectionStatus('待機中', 'Stormworksのウィンドウを検出できません');
    return;
  }
  if (lastInjectedPid === currentStormworksPid) {
    setInjectionStatus('注入済み', 'このStormworksプロセスでは既に注入済みです');
    updateInjectionControl(injectionRenderAllowed());
    return;
  }
  const executable = injectorPath();
  const hook = hookDllPath();
  if (!fs.existsSync(executable) || !fs.existsSync(hook)) {
    setInjectionStatus('失敗', 'DLLインジェクション部品が見つかりません。アプリを再インストールしてください。');
    return;
  }
  const targetPid = currentStormworksPid;
  injectionAttemptInFlight = true;
  setInjectionStatus('注入中', 'StormworksへDLLを読み込んでいます');
  // DLLを読み込むだけでは描画フックは有効にならない。明示的に初期化エクスポートを呼び出す。
  assertNoSymlinkPath(executable);
  assertNoSymlinkPath(hook);
  const child = spawn(executable, [String(targetPid), hook, 'WmoInitializeHook'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
  await new Promise((resolve) => {
    child.once('error', (error) => {
      errorOutput = error.message;
      resolve();
    });
    child.once('close', () => resolve());
  });
  const code = child.exitCode;
  injectionAttemptInFlight = false;
  if (overlayMode !== 'injection' || !overlaySettings
    || currentStormworksPid !== targetPid || !stormworksWindowAvailable) {
    if (overlayMode === 'injection' && overlaySettings && currentStormworksPid && stormworksWindowAvailable
      && lastInjectedPid !== currentStormworksPid) scheduleInjectionAttempt(250);
    return;
  }
  if (code === 0) {
    lastInjectedPid = targetPid;
    setInjectionStatus('注入済み', output.trim() || 'DLLを読み込みました');
    if (injectionRequestedByUser) {
      const saved = saveSettings({ ...loadSettings(), overlayMode: 'injection', injectionWarningAccepted: true, injectionAutoStartAllowed: true });
      overlaySettings = { ...overlaySettings, ...saved, overlayMode: 'injection' };
    }
    updateInjectionControl(injectionRenderAllowed());
    if (currentStormworksPid !== targetPid) scheduleInjectionAttempt(250);
    return;
  }
  const stableByCode = {
    2: '対象PIDが正しくありません。',
    3: 'Hook DLLが見つかりません。',
    4: '対象プロセスがStormworksではありません。',
    5: 'Stormworksへのアクセスが拒否されました。',
    6: 'Stormworksへ注入する準備に失敗しました。',
    7: 'StormworksへDLLを読み込めませんでした。',
    8: 'Hook DLLの読み込みに失敗しました。',
    9: 'DLL読み込みの完了を確認できませんでした。Stormworksを確認してください。',
  };
  setInjectionStatus('失敗', stableByCode[code] || 'DLLを読み込めませんでした。Stormworksが起動中か確認してください。');
  scheduleInjectionAttempt(2500);
}

function createInjectionOverlayWindow() {
  if (injectionOverlayWindow && !injectionOverlayWindow.isDestroyed()) return true;
  try {
    nativeBridge.initialize();
    injectionNativeReady = true;
  } catch (error) {
    injectionNativeReady = false;
    setInjectionStatus('失敗', error.message);
    setOverlayDiagnostic('native-error', error.message);
    return false;
  }
  const createdWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    width: injectionCaptureWidth,
    height: injectionCaptureHeight,
    webPreferences: {
      offscreen: true,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  injectionOverlayWindow = createdWindow;
  try { createdWindow.webContents.setFrameRate(60); } catch (error) { console.warn(`offscreen frame rate setup failed: ${error.message}`); }
  createdWindow.webContents.setAudioMuted(true);
  createdWindow.webContents.on('paint', (_event, _dirty, image) => {
    if (!injectionNativeReady || injectionOverlayWindow !== createdWindow || createdWindow.isDestroyed()) return;
    const size = image.getSize();
    if (!size.width || !size.height || size.width > 1024 || size.height > 1024) return;
    try {
      const bitmap = image.toBitmap();
      nativeBridge.frame(bitmap, size.width, size.height, size.width * 4);
    } catch (error) {
      console.error('共有メモリへの送信に失敗しました:', error);
      setInjectionStatus('失敗', '共有メモリへのフレーム送信に失敗しました。');
    }
  });
  createdWindow.webContents.on('did-finish-load', () => {
    if (injectionOverlayWindow !== createdWindow || createdWindow.isDestroyed()) return;
    injectionPageReady = true;
    void restoreWebMapZoom(createdWindow.webContents);
    if (currentHostUserName && lastGameRect) {
      updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
    }
    updateInjectionControl(injectionRenderAllowed());
  });
  createdWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || injectionOverlayWindow !== createdWindow) return;
    injectionPageReady = false;
    hideOverlay('page-error', `WebMapの読み込みに失敗しました（エラーコード: ${errorCode}）`);
    scheduleOverlayReload(1000, '読み込み失敗後に再試行しています');
  });
  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    if (injectionOverlayWindow !== createdWindow) return;
    injectionPageReady = false;
    hideOverlay('page-error', 'WebMapの描画を再起動しています');
    scheduleOverlayReload(1000, '描画停止後に再試行しています');
  });
  createdWindow.on('closed', () => {
    if (injectionOverlayWindow !== createdWindow) return;
    injectionOverlayWindow = undefined;
    injectionPageReady = false;
    updateInjectionControl(false);
  });
  updateInjectionControl(false);
  return true;
}

function createOverlay(settings, requestedMode = normalizeOverlayMode(settings?.overlayMode)) {
  if (!settings?.userName) {
    overlaySettings = null;
    currentHostUserName = '';
    overlayDiagnostics = { ...overlayDiagnostics, apiStatus: '未接続（ユーザー未選択）', updatedAt: Date.now() };
    setOverlayDiagnostic('player-not-selected', 'あなたのユーザー名を選択してください');
    return false;
  }
  const isNewOverlaySession = !overlaySettings;
  overlayMode = normalizeOverlayMode(requestedMode);
  overlayRatio = normalizeOverlayRatio(settings.overlayRatio);
  overlayMapZoom = normalizeMapZoom(settings.mapZoom);
  overlaySettings = { ...settings, overlayMode, overlayRatio, mapZoom: overlayMapZoom };
  if (isNewOverlaySession) stormworksSeenInCurrentSession = false;
  overlayOpacity = normalizeOpacity(settings.overlayOpacity);
  overlayAnchor = normalizeOverlayAnchor(settings.overlayAnchor ?? overlayAnchor);
  overlayDiagnostics = {
    displayReason: 'waiting-player', apiStatus: 'API確認中', injectionStatus: overlayMode === 'injection' ? '待機中' : '停止', injectionDetail: '', detail: '', updatedAt: Date.now(),
  };
  if (overlayMode === 'injection') {
    if (!createInjectionOverlayWindow()) return false;
    setInjectionStatus('待機中', currentStormworksPid ? 'Stormworksへの注入を準備しています' : 'Stormworksの起動を待っています');
  } else if (stormworksWindowAvailable && (!overlayWindow || overlayWindow.isDestroyed())) {
    overlayWindow = new BrowserWindow({
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      icon: appIconPath,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    keepOverlayAboveGame(true);
    // WebMap は映像表示専用。ページ側に音声要素が追加されてもゲーム中に再生しない。
    overlayWindow.webContents.setAudioMuted(true);
    overlayWindow.setOpacity(overlayOpacity);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.webContents.on('did-finish-load', () => {
      overlayPageReady = true;
      blankOverlayCount = 0;
      void restoreWebMapZoom(overlayWindow.webContents);
      if (currentHostUserName && gameActive && overlayVisible && lastGameRect) {
        updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
      }
    });
    overlayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      overlayPageReady = false;
      hideOverlay('page-error', `WebMapの読み込みに失敗しました（エラーコード: ${errorCode}）`);
      scheduleOverlayReload(1000, '読み込み失敗後に再試行しています');
    });
    overlayWindow.webContents.on('render-process-gone', (_event, details) => {
      overlayPageReady = false;
      hideOverlay('page-error', 'WebMapの描画を再起動しています');
      scheduleOverlayReload(1000, '描画停止後に再試行しています');
    });
    overlayWindow.on('unresponsive', () => {
      overlayPageReady = false;
      hideOverlay('page-error', 'WebMapの描画が応答していません');
      scheduleOverlayReload(1000, '応答停止後に再試行しています');
    });
    overlayWindow.on('responsive', () => {
      if (currentHostUserName && !overlayPageReady) scheduleOverlayReload(250, '描画復旧後に再試行しています');
    });
    overlayWindow.on('closed', () => { overlayWindow = undefined; });
    startBlankOverlayCheck();
  }

  startHostPolling();
  startWindowTracker();
  if (overlayMode === 'injection') scheduleInjectionAttempt();
  return true;
}

function updateOverlayBounds(left, top, right, bottom) {
  if (overlayMode === 'injection') {
    if (!injectionOverlayWindow || injectionOverlayWindow.isDestroyed()) {
      if (overlaySettings) {
        createInjectionOverlayWindow();
        if (currentHostUserName && !injectionPageReady) loadOverlayPage(currentHostUserName, 'page-loading', 'Stormworks検出後にWebMapを読み込んでいます');
      }
    }
  } else if ((!overlayWindow || overlayWindow.isDestroyed()) && overlaySettings && currentHostUserName) {
    createOverlay(overlaySettings);
    if (currentHostUserName) loadOverlayPage(currentHostUserName);
  }
  if (overlayMode === 'injection' && (!injectionOverlayWindow || injectionOverlayWindow.isDestroyed())) return;
  if (overlayMode !== 'injection' && (!overlayWindow || overlayWindow.isDestroyed())) return;
  lastGameRect = { left, top, right, bottom };
  const windowWidth = right - left;
  const windowHeight = bottom - top;
  if (windowWidth < 320 || windowHeight < 320) return;
  const size = Math.max(160, Math.round(Math.min(windowWidth, windowHeight) * overlayRatio));
  const margin = Math.max(16, Math.round(size * 0.075));
  const isRight = overlayAnchor.endsWith('right');
  const isTop = overlayAnchor.startsWith('top');
  const x = isRight ? right - margin - size : left + margin;
  const y = isTop ? top + margin : bottom - margin - size;
  if (overlayMode === 'injection') {
    injectionCaptureWidth = Math.min(1024, Math.max(160, size));
    injectionCaptureHeight = injectionCaptureWidth;
    try { injectionOverlayWindow.setContentSize(injectionCaptureWidth, injectionCaptureHeight); } catch (error) { console.error(`offscreen resize failed: ${error.message}`); }
    updateInjectionControl(injectionRenderAllowed());
    if (!injectionPageReady && currentHostUserName) {
      setOverlayDiagnostic('page-loading', 'WebMapを読み込んでいます');
    } else if (injectionRenderAllowed()) {
      setOverlayDiagnostic('visible', `ホスト: ${currentHostUserName}`);
    }
    return;
  }
  overlayWindow.setBounds({ x, y, width: size, height: size });
  if (overlayVisible && currentHostUserName && overlayPageReady) {
    overlayWindow.showInactive();
    keepOverlayAboveGame();
    setOverlayDiagnostic('visible', `ホスト: ${currentHostUserName}`);
  } else if (currentHostUserName && !overlayPageReady) {
    overlayWindow.hide();
  }
}

function prepareTrackerScript(source) {
  const typeDefinition = /^Add-Type @'([\s\S]*?)\r?\n'@/.exec(source);
  if (!typeDefinition) return source;
  const encodedTypeDefinition = Buffer.from(typeDefinition[1], 'utf8').toString('base64');
  const replacement = `Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedTypeDefinition}')))`;
  return source.replace(typeDefinition[0], replacement);
}

function startWindowTracker() {
  if (trackerProcess) return;
  const bindings = normalizeKeyBindings(overlaySettings);
  const trackerParameters = {
    ToggleVk: bindingVirtualKey(bindings.toggle),
    SpotVk: bindingVirtualKey(bindings.spot),
    ZoomInVk: bindingVirtualKey(bindings.zoomIn),
    ZoomOutVk: bindingVirtualKey(bindings.zoomOut),
    ReloadVk: bindingVirtualKey(bindings.reload),
    SizeIncreaseVk: bindingVirtualKey(bindings.sizeIncrease),
    SizeDecreaseVk: bindingVirtualKey(bindings.sizeDecrease),
    OpacityIncreaseVk: bindingVirtualKey(bindings.opacityIncrease),
    OpacityDecreaseVk: bindingVirtualKey(bindings.opacityDecrease),
    MouseModifierVk: bindingVirtualKey(bindings.mouseModifier),
  };
  const parameterScript = Object.entries(trackerParameters)
    .map(([name, code]) => `$${name} = ${Number(code)}`)
    .join('\r\n');
  const preparedTrackerScript = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    parameterScript,
    prepareTrackerScript(windowTrackerScript),
  ].join('\r\n');
  const trackerArgs = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text',
    '-Command', '$source = [Console]::In.ReadToEnd(); Invoke-Expression $source',
  ];
  const spawnedTracker = spawn('powershell.exe', trackerArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  trackerProcess = spawnedTracker;
  let trackerBuffer = '';
  let trackerErrorText = '';
  spawnedTracker.stdin.on('error', (error) => {
    // EPIPE can occur when PowerShell exits during startup; the exit handler performs the restart.
    console.error(`window tracker stdin failed: ${error.message}`);
  });
  spawnedTracker.stderr.on('data', (chunk) => { trackerErrorText += chunk.toString(); });
  spawnedTracker.stdout.on('data', (chunk) => {
    // 再起動直後に旧trackerが出す残留stdoutを現行状態へ混ぜない。
    if (trackerProcess !== spawnedTracker || isQuitting || !overlaySettings) return;
    trackerBuffer += chunk.toString();
    const lines = trackerBuffer.split(/\r?\n/);
    trackerBuffer = lines.pop();
    for (const line of lines) {
      const trackerStatus = parseTrackerStatus(line);
      if (trackerStatus?.type === 'rect') {
        const wasAvailable = stormworksWindowAvailable;
        const previousPid = currentStormworksPid;
        const injectionWindowWasMissing = overlayMode === 'injection'
          && (!injectionOverlayWindow || injectionOverlayWindow.isDestroyed());
        trackerRestartAttempts = 0;
        setStormworksState('tracker:rect', true, trackerStatus.active, trackerStatus.pid);
        stormworksSeenInCurrentSession = true;
        if (overlayMode === 'injection' || trackerStatus.active) {
          updateOverlayBounds(trackerStatus.left, trackerStatus.top, trackerStatus.right, trackerStatus.bottom);
        } else {
          hideOverlay('game-inactive');
        }
        if (overlayMode === 'injection' && (!wasAvailable || previousPid !== currentStormworksPid)) {
          if (!injectionWindowWasMissing && currentHostUserName && !injectionPageReady
            && injectionOverlayWindow && !injectionOverlayWindow.isDestroyed()) {
            loadOverlayPage(currentHostUserName, 'page-loading', 'Stormworks検出後にWebMapを読み込んでいます');
          }
          scheduleInjectionAttempt();
        }
      } else if (trackerStatus?.type === 'none') {
        trackerRestartAttempts = 0;
        setStormworksState('tracker:none', false, false, trackerStatus.pid);
        if (injectionMonitorTimer) {
          clearTimeout(injectionMonitorTimer);
          injectionMonitorTimer = null;
        }
        destroyOverlayWindow('game-window-not-found', 'Stormworks は起動していません');
      } else if (trackerStatus?.type === 'exited') {
        trackerRestartAttempts = 0;
        setStormworksState('tracker:exited', false, false, 0);
        lastInjectedPid = 0;
        if (injectionMonitorTimer) {
          clearTimeout(injectionMonitorTimer);
          injectionMonitorTimer = null;
        }
        if (overlayMode === 'injection') setInjectionStatus('待機中', 'Stormworksは終了しました。起動を待っています');
        applyPendingUpdateAfterStormworksExit();
        destroyOverlayWindow('game-window-not-found', 'Stormworks は終了しました');
        if (stormworksSeenInCurrentSession && overlaySettings?.autoExitOnStormworksExit) {
          app.quit();
          return;
        }
      } else if (trackerStatus?.type === 'inactive') {
        trackerRestartAttempts = 0;
        setStormworksState('tracker:inactive', true, false, trackerStatus.pid || currentStormworksPid || 0);
        stormworksSeenInCurrentSession = true;
        if (overlayMode === 'injection') {
          if (lastGameRect) {
            updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
            scheduleInjectionAttempt();
          }
          updateInjectionControl(injectionRenderAllowed());
        } else {
          hideOverlay('game-inactive');
        }
      } else if (line.trim() === 'key:alt-toggle') {
        overlayVisible = !overlayVisible;
        if (overlayMode === 'injection') {
          if (injectionRenderAllowed()) {
            updateInjectionControl(true);
            setOverlayDiagnostic('visible', `ホスト: ${currentHostUserName}`);
          } else {
            updateInjectionControl(false);
            if (!overlayVisible) setOverlayDiagnostic('manual-hidden');
          }
        } else if (overlayWindow && !overlayWindow.isDestroyed()) {
          if (overlayVisible && gameActive && currentHostUserName) {
            overlayWindow.showInactive();
            keepOverlayAboveGame(true);
            setOverlayDiagnostic('visible', `ホスト: ${currentHostUserName}`);
          } else if (!overlayVisible) {
            hideOverlay('manual-hidden');
          }
        }
      } else if (line.trim() === 'key:spot') {
        void requestUnknownTankSpot();
      } else if (line.trim() === 'key:reload') reloadOverlayPage();
      else if (line.trim() === 'key:zoom-in') changeWebMapZoom(1);
      else if (line.trim() === 'key:zoom-out') changeWebMapZoom(-1);
      else if (line.trim() === 'key:size-increase' && lastGameRect) {
        overlayVisible = true;
        overlayRatio = normalizeOverlayRatio(overlayRatio + 0.025);
        updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
        scheduleOverlaySettingsSave();
      } else if (line.trim() === 'key:size-decrease' && lastGameRect) {
        overlayRatio = normalizeOverlayRatio(overlayRatio - 0.025);
        updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
        scheduleOverlaySettingsSave();
      } else if (line.trim() === 'key:opacity-increase' && (overlayMode === 'injection' || (overlayWindow && !overlayWindow.isDestroyed()))) {
        overlayOpacity = Math.min(1.0, overlayOpacity + 0.10);
        if (overlayMode === 'injection') updateInjectionControl(injectionRenderAllowed());
        else overlayWindow.setOpacity(overlayOpacity);
        scheduleOpacitySave();
      } else if (line.trim() === 'key:opacity-decrease' && (overlayMode === 'injection' || (overlayWindow && !overlayWindow.isDestroyed()))) {
        overlayOpacity = Math.max(0.20, overlayOpacity - 0.10);
        if (overlayMode === 'injection') updateInjectionControl(injectionRenderAllowed());
        else overlayWindow.setOpacity(overlayOpacity);
        scheduleOpacitySave();
      } else if (line.trim().startsWith('wheel:')) {
        const delta = Number(line.trim().slice(6));
        if (!Number.isFinite(delta) || !lastGameRect) continue;
        overlayVisible = true;
        overlayRatio = normalizeOverlayRatio(overlayRatio + (delta > 0 ? 0.025 : -0.025));
        updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
        scheduleOverlaySettingsSave();
      } else if (line.trim().startsWith('tilt:')) {
        const delta = Number(line.trim().slice(5));
        if (!Number.isFinite(delta) || (overlayMode !== 'injection' && (!overlayWindow || overlayWindow.isDestroyed()))) continue;
        overlayOpacity = Math.max(0.20, Math.min(1.0, overlayOpacity + (delta > 0 ? 0.10 : -0.10)));
        if (overlayMode === 'injection') updateInjectionControl(injectionRenderAllowed());
        else overlayWindow.setOpacity(overlayOpacity);
        scheduleOpacitySave();
        console.log(`MiniMap opacity: ${Math.round(overlayOpacity * 100)}%`);
      }
    }
  });
  const restartTracker = (detail) => {
    if (trackerProcess !== spawnedTracker) return;
    trackerProcess = undefined;
    if (trackerRestartTimer) {
      clearTimeout(trackerRestartTimer);
      trackerRestartTimer = null;
    }
    trackerBuffer = '';
    setStormworksState('lifecycle:tracker-restart', false, false, 0);
    if (injectionMonitorTimer) {
      clearTimeout(injectionMonitorTimer);
      injectionMonitorTimer = null;
    }
    if (!overlaySettings || isQuitting) return;
    hideOverlay('tracker-unavailable', detail);
    if (overlayMode === 'injection') setInjectionStatus('待機中', 'Stormworksの前面状態を確認できません');
    if (trackerRestartAttempts >= 3) return;
    trackerRestartAttempts += 1;
    const delay = trackerRestartAttempts * 1000;
    trackerRestartTimer = setTimeout(() => {
      trackerRestartTimer = null;
      if (overlaySettings && !trackerProcess && !isQuitting) startWindowTracker();
    }, delay);
  };
  spawnedTracker.on('error', (error) => {
    console.error(`window tracker process failed: ${error.message}`);
    restartTracker('Stormworks監視を開始できません。');
  });
  spawnedTracker.on('exit', (code, signal) => {
    if (trackerErrorText.trim()) console.error(`window tracker stderr: ${trackerErrorText.trim()}`);
    const detail = code === 0 ? 'Stormworks監視が終了しました。' : 'Stormworks監視を再起動しています。';
    restartTracker(detail);
  });
  try {
    spawnedTracker.stdin.end(preparedTrackerScript, 'utf8');
  } catch (error) {
    console.error(`window tracker stdin setup failed: ${error.message}`);
    restartTracker('Stormworks監視を開始できません。');
  }
}

function restartWindowTracker() {
  if (trackerRestartTimer) {
    clearTimeout(trackerRestartTimer);
    trackerRestartTimer = null;
  }
  if (trackerProcess) {
    trackerProcess.kill();
    trackerProcess = undefined;
  }
  setStormworksState('lifecycle:tracker-restart', false, false, 0);
  if (injectionMonitorTimer) {
    clearTimeout(injectionMonitorTimer);
    injectionMonitorTimer = null;
  }
  if (overlaySettings) {
    hideOverlay('tracker-unavailable', 'Stormworks監視を再起動しています');
    if (overlayMode === 'injection') setInjectionStatus('待機中', 'Stormworksの前面状態を確認しています');
  }
  startWindowTracker();
}

function stopOverlay() {
  flushOverlaySettingsSave();
  stopHostPolling();
  if (injectionMonitorTimer) {
    clearTimeout(injectionMonitorTimer);
    injectionMonitorTimer = null;
  }
  if (injectionNativeReady) {
    try { nativeBridge.reset(); } catch (error) { console.error(`injection control reset failed: ${error.message}`); }
  }
  overlaySettings = null;
  currentHostUserName = '';
  setStormworksState('lifecycle:stop', false, false, 0);
  lastInjectedPid = 0;
  stormworksSeenInCurrentSession = false;
  if (trackerProcess) {
    trackerProcess.kill();
    trackerProcess = undefined;
  }
  if (trackerRestartTimer) {
    clearTimeout(trackerRestartTimer);
    trackerRestartTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  if (injectionOverlayWindow && !injectionOverlayWindow.isDestroyed()) {
    injectionOverlayWindow.close();
  }
  overlayWindow = undefined;
  injectionOverlayWindow = undefined;
  injectionPageReady = false;
  injectionRequestedByUser = false;
  lastGameRect = null;
  overlayVisible = true;
  overlayMode = 'safe';
  injectionNativeReady = false;
  overlayDiagnostics = { displayReason: 'stopped', apiStatus: '未確認', detail: '', updatedAt: Date.now() };
  return true;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powerShellErrorMessage(_errorText, exitCode) {
  return `Windowsの設定変更に失敗しました（終了コード: ${exitCode}）`;
}

function runPowerShell(script, elevated = false) {
  return new Promise((resolve, reject) => {
    const preparedScript = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      script,
    ].join('\r\n');
    const encoded = Buffer.from(preparedScript, 'utf16le').toString('base64');
    const childArguments = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${encoded}`;
    const elevationLauncher = [
      "$ErrorActionPreference = 'Stop'",
      `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${powerShellQuote(childArguments)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode }`,
      "catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; throw }",
    ].join('\r\n');
    const args = elevated
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-Command', elevationLauncher]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded];
    const process = spawn('powershell.exe', args, { windowsHide: true });
    let errorText = '';
    let outputText = '';
    process.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
    process.stdout.on('data', (chunk) => { outputText += chunk.toString(); });
    process.on('error', reject);
    process.on('exit', (code) => {
      if (code === 0) return resolve(outputText.trim());
      if (errorText.trim()) console.error(`PowerShell error (${code}): ${errorText.trim()}`);
      const error = new Error(powerShellErrorMessage(errorText, code));
      error.exitCode = code;
      error.rawError = errorText;
      error.cancelled = elevated && code === 1223;
      reject(error);
    });
  });
}

function stormworksLaunchTarget() {
  if (app.isPackaged) return { executable: process.execPath, args: ['--autostart'] };
  return {
    executable: process.execPath,
    args: [__dirname, `--user-data-dir=${path.join(__dirname, 'user-data')}`, '--autostart'],
  };
}

function stormworksWatcherPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'WebMapOverlayWatcher.exe')
    : path.join(__dirname, 'build', 'bin', 'WebMapOverlayWatcher.exe');
}

function quoteTaskArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function stormworksWatcherArguments() {
  const launch = stormworksLaunchTarget();
  return [launch.executable, ...launch.args].map(quoteTaskArgument).join(' ');
}

// 更新中は resources 配下の監視 EXE が置換され、実行中の監視プロセスも終了する。
// 更新後に再起動された本体から新しい監視 EXE を起動して、次回の Stormworks 起動を待機する。
function ensureStormworksLaunchWatcher() {
  const settings = loadSettings();
  if (!settings.launchWithStormworks) return;
  const watcherPath = stormworksWatcherPath();
  if (!fs.existsSync(watcherPath)) {
    console.error('Stormworks launch watcher was not found.');
    return;
  }
  const launch = stormworksLaunchTarget();
  try {
    assertNoSymlinkPath(watcherPath);
    const watcher = spawn(watcherPath, [launch.executable, ...launch.args], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    watcher.once('error', (error) => console.error(`Stormworks launch watcher failed: ${error.message}`));
    watcher.unref();
  } catch (error) {
    console.error(`Stormworks launch watcher failed: ${error.message}`);
  }
}

async function setStormworksLaunchTask(enabled) {
  const watcherPath = stormworksWatcherPath();
  if (!enabled) {
    const script = [
      `$watcherPath = ${powerShellQuote(watcherPath)}`,
      `$task = Get-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -ErrorAction SilentlyContinue`,
      'if ($null -ne $task) {',
      `  Stop-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -ErrorAction SilentlyContinue`,
      `  Unregister-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -Confirm:$false -ErrorAction Stop`,
      '}',
      // 更新後に本体から直接起動した監視プロセスも、解除時には必ず終了する。
      "$watchers = Get-Process -Name 'WebMapOverlayWatcher' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals($_.Path, $watcherPath, [System.StringComparison]::OrdinalIgnoreCase) }",
      '$watchers | Stop-Process -Force -ErrorAction SilentlyContinue',
    ].join('\r\n');
    try { await runPowerShell(script); }
    catch { await runPowerShell(script, true); }
    return { ok: true, enabled: false };
  }
  if (!fs.existsSync(watcherPath)) throw new Error('起動監視プログラムが見つかりません。アプリを再インストールしてください。');
  const scheduledTaskUser = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  const watcherArguments = stormworksWatcherArguments();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$currentUser = ${powerShellQuote(scheduledTaskUser)}`,
    `Stop-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -ErrorAction SilentlyContinue`,
    `$action = New-ScheduledTaskAction -Execute ${powerShellQuote(watcherPath)} -Argument ${powerShellQuote(watcherArguments)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -Action $action -Trigger $trigger -Principal $principal -Description 'Stormworks の起動を検出して WebMap Overlay を起動します。' -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -ErrorAction SilentlyContinue`,
  ].join('\r\n');
  try { await runPowerShell(script); }
  catch { await runPowerShell(script, true); }
  return { ok: true, enabled: true };
}

async function stormworksLaunchTaskStatus() {
  try {
    const output = await runPowerShell([
      `$task = Get-ScheduledTask -TaskName ${powerShellQuote(stormworksLaunchTaskName)} -ErrorAction Stop`,
      '[PSCustomObject]@{ Execute = [string]$task.Actions.Execute; Arguments = [string]$task.Actions.Arguments } | ConvertTo-Json -Compress',
    ].join('\r\n'));
    const task = JSON.parse(output);
    const execute = path.normalize(String(task.Execute || '')).toLowerCase();
    const argumentsText = String(task.Arguments || '').toLowerCase();
    const current = execute === path.normalize(stormworksWatcherPath()).toLowerCase()
      && argumentsText === stormworksWatcherArguments().toLowerCase();
    return { enabled: true, current };
  } catch {
    return { enabled: false, current: false };
  }
}

async function promptUpdateInstall(info) {
  if (!info || pendingUpdatePromptInFlight || isQuitting) return;
  pendingUpdatePromptInFlight = true;
  try {
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['再起動して更新', '後で行う'],
      defaultId: 0,
      cancelId: 1,
      title: 'WebMap Overlay の更新',
      message: `バージョン ${info.version} をダウンロードしました。`,
      detail: '再起動すると更新が適用されます。',
    });
    if (result.response === 0) {
      try { signedUpdates.install(); }
      catch (error) { console.error('更新の検証に失敗しました:', error.message); await dialog.showMessageBox({type: 'error', title: '更新エラー', message: '更新を検証できなかったため、適用を中止しました。', buttons: ['閉じる']}); }
    }
  } finally {
    pendingUpdatePromptInFlight = false;
  }
}

function applyPendingUpdateAfterStormworksExit() {
  if (!pendingUpdateInfo || currentStormworksPid !== 0 || !autoUpdater) return;
  const info = pendingUpdateInfo;
  pendingUpdateInfo = null;
  void promptUpdateInstall(info);
}

function setupAutoUpdater() {
  // electron-updater はインストーラー版だけで利用する。BATでの開発起動では更新対象がない。
  if (!app.isPackaged || !autoUpdater) return;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  autoUpdater.setFeedURL(updateFeed);
  if (!autoUpdaterInitialized) {
    autoUpdaterInitialized = true;
    autoUpdater.on('error', (error) => console.error(`更新確認に失敗しました: ${error.message}`));
    autoUpdater.on('update-available', async (info) => {
      try {
        await signedUpdates.prepare(info);
        const result = await dialog.showMessageBox({type: 'info', title: 'WebMap Overlay の更新',
          message: `バージョン ${info.version} を利用できます。`, detail: '署名を確認しました。ダウンロードしますか？',
          buttons: ['ダウンロード', '後で行う'], defaultId: 0, cancelId: 1});
        if (result.response === 0) await signedUpdates.download(info);
      } catch (error) {
        console.error(`更新の検証またはダウンロードに失敗しました: ${error.message}`);
        await dialog.showMessageBox({type: 'error', title: '更新エラー', message: '更新を確認できませんでした。', buttons: ['閉じる']});
      }
    });
    autoUpdater.on('update-downloaded', async (info) => {
      try { signedUpdates.verifyDownloaded(info); }
      catch (error) {
        console.error(`ダウンロードした更新の検証に失敗しました: ${error.message}`);
        await dialog.showMessageBox({type: 'error', title: '更新エラー', message: '更新を検証できなかったため、適用を中止しました。', buttons: ['閉じる']});
        return;
      }
      if (overlayMode === 'injection' && lastInjectedPid && currentStormworksPid) {
        pendingUpdateInfo = info;
        setInjectionStatus('休止', 'Hook DLL使用中のため、Stormworks終了後まで更新を延期しています');
        return;
      }
      await promptUpdateInstall(info);
    });
  }
  const check = () => autoUpdater.checkForUpdates().catch((error) => console.error(`update check failed: ${error.message}`));
  check();
  updateCheckTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

function showLicenses() {
  const licensePath = app.isPackaged
    ? path.join(process.resourcesPath, 'LICENSES.txt')
    : path.join(__dirname, 'LICENSES.txt');
  let licenseText;
  try {
    licenseText = fs.readFileSync(licensePath, 'utf8');
  } catch {
    licenseText = 'ライセンスファイルを読み込めませんでした。';
  }
  return dialog.showMessageBox(configWindow, {
    type: 'info',
    title: 'ライセンス情報',
    message: '第三者ライセンス一覧',
    detail: licenseText,
    buttons: ['閉じる'],
    defaultId: 0,
  });
}

function showReadme() {
  if (readmeWindow && !readmeWindow.isDestroyed()) {
    readmeWindow.focus();
    return;
  }
  const readmePath = app.isPackaged
    ? path.join(process.resourcesPath, 'README.txt')
    : path.join(__dirname, 'README.txt');
  let readmeText;
  try {
    readmeText = fs.readFileSync(readmePath, 'utf8');
  } catch {
    readmeText = 'READMEファイルを読み込めませんでした。';
  }
  const escapedText = readmeText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const documentHtml = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${appTitle} - README</title><style>body{margin:0;padding:24px;background:#f6f7f9;color:#1c222b;font-family:"Yu Gothic UI","Segoe UI",sans-serif}pre{max-width:860px;margin:0 auto;padding:22px 24px;border:1px solid #e3e6eb;border-radius:8px;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.75 "Yu Gothic UI","Segoe UI",sans-serif}</style><body><pre>${escapedText}</pre></body></html>`;
  readmeWindow = new BrowserWindow({
    width: 780,
    height: 720,
    title: `${appTitle} - README`,
    parent: configWindow,
    show: false,
    resizable: true,
    minWidth: 520,
    minHeight: 420,
    autoHideMenuBar: true,
    icon: appIconPath,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  readmeWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(documentHtml)}`);
  readmeWindow.webContents.on('page-title-updated', (event) => event.preventDefault());
  readmeWindow.once('ready-to-show', () => readmeWindow.show());
  readmeWindow.on('closed', () => { readmeWindow = undefined; });
}

function createConfigWindow(show = true) {
  configWindow = new BrowserWindow({
    width: 450,
    height: 760,
    useContentSize: true,
    title: appTitle,
    show,
    resizable: true,
    minWidth: 420,
    minHeight: 640,
    icon: appIconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  configWindow.loadFile(path.join(__dirname, 'config.html'));
  if (!show) {
    // 起動連動時もタスクバーから設定を開けるよう、非アクティブのまま最小化する。
    configWindow.once('ready-to-show', () => {
      if (!configWindow || configWindow.isDestroyed()) return;
      configWindow.showInactive();
      configWindow.minimize();
    });
  }
  // HTMLの<title>で、バージョン付きのネイティブタイトルが上書きされないようにする。
  configWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    configWindow.setTitle(appTitle);
  });
  configWindow.webContents.once('did-finish-load', () => configWindow.setTitle(appTitle));
  configWindow.on('closed', () => {
    if (!isQuitting) app.quit();
  });
}

function createKeybindingsWindow() {
  if (keybindingsWindow && !keybindingsWindow.isDestroyed()) {
    keybindingsWindow.focus();
    return;
  }
  keybindingsWindow = new BrowserWindow({
    width: 640,
    height: 820,
    useContentSize: true,
    title: `${appTitle} - 設定`,
    parent: configWindow,
    modal: true,
    show: false,
    resizable: true,
    minWidth: 560,
    minHeight: 620,
    autoHideMenuBar: true,
    icon: appIconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  keybindingsWindow.loadFile(path.join(__dirname, 'keybindings.html'));
  keybindingsWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    keybindingsWindow.setTitle(`${appTitle} - 設定`);
  });
  keybindingsWindow.webContents.once('did-finish-load', () => keybindingsWindow.setTitle(`${appTitle} - 設定`));
  keybindingsWindow.once('ready-to-show', () => keybindingsWindow.show());
  keybindingsWindow.on('closed', () => { keybindingsWindow = undefined; });
}

async function loadSelectionLists() {
  const settings = loadSettings();
  const baseUrl = new URL(settings.url || defaultUrl);
  const [hostResponse, userResponse] = await Promise.all([
    fetch(new URL('/api/webmap/hosts', baseUrl.origin)),
    fetch(new URL('/api/steam/usernames', baseUrl.origin)),
  ]);
  if (!hostResponse.ok || !userResponse.ok) throw new Error('一覧を取得できませんでした');
  const hostData = await hostResponse.json();
  const userData = await userResponse.json();
  const hosts = (Array.isArray(hostData?.hosts) ? hostData.hosts : []).map((host) => ({
    value: String(host.host_user_name || ''),
    label: `${host.host_user_name || 'Unknown'} — ${host.is_online ? 'オンライン' : 'オフライン'}`,
  })).filter((host) => host.value);
  const rawUsers = userData?.steam_usernames || {};
  const users = Object.entries(rawUsers).map(([steamId64, name]) => ({
    value: String(steamId64), label: `${name || 'Unknown'} (${steamId64})`,
  })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  return { hosts, users };
}

const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(channel, (event, ...args) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const allowedFile = window === configWindow ? 'config.html' : window === keybindingsWindow ? 'keybindings.html' : null;
  if (!allowedFile || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(path.join(__dirname, allowedFile)).href) {
    throw new Error('この操作は許可されていません。');
  }
  return handler(event, ...args);
});

ipcMain.handle('settings', () => loadSettings());
ipcMain.handle('save-settings', (_event, settings) => {
  // サイズ・ズーム・透明度の変更を、設定画面やキー設定画面の保存で巻き戻さない。
  flushOverlaySettingsSave();
  const trusted = loadSettings();
  const saved = saveSettings({...settings, injectionWarningAccepted: trusted.injectionWarningAccepted, injectionAutoStartAllowed: trusted.injectionAutoStartAllowed});
  if (overlaySettings) {
    const keyBindingChanged = JSON.stringify(saved.keyBindings) !== JSON.stringify(overlaySettings.keyBindings);
    const positionChanged = saved.overlayAnchor !== overlaySettings.overlayAnchor;
    const ratioChanged = saved.overlayRatio !== overlayRatio;
    const opacityChanged = saved.overlayOpacity !== overlayOpacity;
    const mapZoomChanged = saved.mapZoom !== overlayMapZoom;
    const connectionChanged = saved.userName !== overlaySettings.userName || saved.url !== overlaySettings.url;
    overlaySettings = { ...overlaySettings, ...saved, overlayMode };
    overlayRatio = saved.overlayRatio;
    overlayMapZoom = saved.mapZoom;
    overlayOpacity = saved.overlayOpacity;
    overlayAnchor = saved.overlayAnchor;
    if (keyBindingChanged) restartWindowTracker();
    if (positionChanged && lastGameRect) {
      updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
    }
    if (ratioChanged && lastGameRect) {
      updateOverlayBounds(lastGameRect.left, lastGameRect.top, lastGameRect.right, lastGameRect.bottom);
    }
    if (opacityChanged) {
      if (overlayMode === 'injection') updateInjectionControl(injectionRenderAllowed());
      else if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setOpacity(overlayOpacity);
    }
    if (mapZoomChanged) void restoreWebMapZoom(activeOverlayContents());
    if (overlayMode === 'injection') updateInjectionControl(injectionRenderAllowed());
    if (connectionChanged) {
      // 同じホストにいる別ユーザーへ変更した場合も、steam_64 を含むURLを必ず更新する。
      currentHostUserName = '';
      hostPollFailureCount = 0;
      overlayDiagnostics = {
        ...overlayDiagnostics,
        apiStatus: saved.userName ? 'API確認中' : '未接続（ユーザー未選択）',
        updatedAt: Date.now(),
      };
      hideOverlay(
        saved.userName ? 'waiting-player' : 'player-not-selected',
        saved.userName ? '変更したユーザーの接続先を確認しています' : 'あなたのユーザー名を選択してください',
      );
      startHostPolling(true);
    }
  }
  return saved;
});
ipcMain.handle('open-keybindings', () => { createKeybindingsWindow(); return { ok: true }; });
ipcMain.handle('close-keybindings', () => {
  if (keybindingsWindow && !keybindingsWindow.isDestroyed()) keybindingsWindow.close();
  return { ok: true };
});
ipcMain.handle('start-overlay', async (_event, settings, requestedMode = 'safe') => {
  const mode = normalizeOverlayMode(requestedMode);
  try {
    const existing = loadSettings();
    let warningAccepted = Boolean(existing.injectionWarningAccepted);
    if (mode === 'injection' && !warningAccepted) {
      const confirmation = await dialog.showMessageBox(configWindow, {
        type: 'warning',
        title: 'ゲーム内描画（フルスクリーン対応）の確認',
        message: 'ゲーム内描画を開始します。',
        detail: 'Stormworksの画面内部へWebMapを描画するため、DLLをゲームプロセスへ読み込みます。まれにゲームがクラッシュしたり、セキュリティソフトが警告したりする可能性があります。了承した場合のみ続行してください。',
        buttons: ['了承して開始', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
      });
      if (confirmation.response !== 0) return { ok: false, cancelled: true, error: 'ゲーム内描画の開始をキャンセルしました。' };
      warningAccepted = true;
    }
    const saved = saveSettings({
      ...settings,
      overlayMode: mode === 'safe' ? 'safe' : existing.overlayMode,
      injectionWarningAccepted: warningAccepted,
      injectionAutoStartAllowed: existing.injectionAutoStartAllowed,
    });
    injectionRequestedByUser = mode === 'injection';
    if (!createOverlay({ ...saved, overlayMode: mode }, mode)) return { ok: false, error: 'あなたのユーザー名を選択してください。' };
    if (mode === 'safe') saveSettings({ ...saved, overlayMode: 'safe' });
    return { ok: true, mode, pending: mode === 'injection' && !lastInjectedPid };
  }
  catch (error) { console.error(error); return { ok: false, error: '操作に失敗しました。設定を確認してください。' }; }
});
ipcMain.handle('stop-overlay', () => ({ ok: stopOverlay() }));
ipcMain.handle('set-stormworks-launch', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('設定が正しくありません。');
  const previous = await stormworksLaunchTaskStatus();
  const needsUpdate = Boolean(enabled) && !previous.current;
  if (Boolean(enabled) !== previous.enabled || needsUpdate) {
    const action = enabled ? (needsUpdate ? '更新' : '登録') : '削除';
    const confirmation = await dialog.showMessageBox(configWindow, {
      type: 'question',
      title: 'Stormworks 起動連動',
      message: `タスクスケジューラへ起動待機タスクを${action}します。`,
      detail: 'Windowsの管理者確認が表示されます。拒否した場合は設定を変更しません。',
      buttons: ['続行', 'キャンセル'],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return { ok: false, enabled: previous.enabled, cancelled: true };
  }
  try {
    const result = await setStormworksLaunchTask(Boolean(enabled));
    const settings = loadSettings();
    saveSettings({ ...settings, launchWithStormworks: result.enabled });
    return result;
  } catch (error) {
    return { ok: false, enabled: previous.enabled, cancelled: Boolean(error.cancelled), error: error.message };
  }
});
ipcMain.handle('stormworks-launch-status', () => stormworksLaunchTaskStatus());
ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.quit();
  return { ok: true };
});
ipcMain.handle('show-readme', () => {
  showReadme();
  return { ok: true };
});
ipcMain.handle('show-licenses', async () => {
  await showLicenses();
  return { ok: true };
});
ipcMain.handle('load-selection-lists', async () => {
  try { return { ok: true, ...(await loadSelectionLists()) }; }
  catch (error) { console.error(error); return { ok: false, error: '操作に失敗しました。設定を確認してください。' }; }
});
ipcMain.handle('overlay-status', () => ({
  active: overlayMode === 'injection'
    ? injectionRenderAllowed()
    : Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
}));
// 実行中は、WebMapウィンドウの有無ではなく監視・ポーリング設定の有無で判断する。
// オフライン時はWebMapウィンドウを破棄するが、利用者が停止操作できる状態を維持する。
ipcMain.handle('overlay-running', () => ({ active: Boolean(overlaySettings) }));
ipcMain.handle('overlay-diagnostics', () => ({
  running: Boolean(overlaySettings),
  mode: overlayMode,
  visible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
  injectionVisible: injectionRenderAllowed(),
  stormworksPid: currentStormworksPid,
  gameActive,
  stormworksWindowAvailable,
  hostUserName: currentHostUserName,
  opacityPercent: Math.round(overlayOpacity * 100),
  overlaySizePercent: Math.round(overlayRatio * 100),
  mapZoom: overlayMapZoom,
  ...overlayDiagnostics,
}));

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
  contents.on('will-navigate', (event, target) => {
    try {
      const currentUrl = contents.getURL() || ((contents === overlayWindow?.webContents || contents === injectionOverlayWindow?.webContents) ? overlaySettings?.url : '');
      const current = new URL(currentUrl);
      const next = new URL(target);
      if (!['http:', 'https:'].includes(current.protocol) || next.origin !== current.origin || next.username || next.password) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  contents.on('will-redirect', (event, target) => {
    try {
      const currentUrl = contents.getURL() || ((contents === overlayWindow?.webContents || contents === injectionOverlayWindow?.webContents) ? overlaySettings?.url : '');
      const current = new URL(currentUrl);
      const next = new URL(target);
      if (!['http:', 'https:'].includes(current.protocol) || next.origin !== current.origin || next.username || next.password) event.preventDefault();
    } catch { event.preventDefault(); }
  });
});

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    // Stormworksの起動連動による二重起動では、設定画面を前面に出さない。
    if (commandLine.includes('--autostart')) return;
    if (configWindow && !configWindow.isDestroyed()) {
      configWindow.show();
      configWindow.focus();
    }
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const settings = loadSettings();
    createConfigWindow(!startedByStormworks);
    ensureStormworksLaunchWatcher();
    if (settings.autoConnect && settings.userName) {
      const savedMode = normalizeOverlayMode(settings.overlayMode);
      const injectionAllowed = settings.injectionWarningAccepted && settings.injectionAutoStartAllowed;
      if (savedMode === 'safe' || injectionAllowed) {
        createOverlay(settings, savedMode);
      } else {
        setInjectionStatus('停止', 'DLL方式の自動開始は、手動で注入に成功した後に有効になります');
      }
    }
    setupAutoUpdater();
  });
}
app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (trackerProcess) trackerProcess.kill();
  if (injectionNativeReady) {
    try { nativeBridge.reset(); } catch (error) { console.error(`before-quit control reset failed: ${error.message}`); }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  if (injectionOverlayWindow && !injectionOverlayWindow.isDestroyed()) injectionOverlayWindow.destroy();
});
