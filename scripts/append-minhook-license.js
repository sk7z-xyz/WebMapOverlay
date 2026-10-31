const fs = require('fs');
const path = require('path');

const projectDirectory = path.join(__dirname, '..');
const licensePath = path.join(projectDirectory, 'LICENSES.txt');
const minHookLicensePath = path.join(projectDirectory, 'native', 'vendor', 'MinHook-LICENSE.txt');
if (!fs.existsSync(licensePath) || !fs.existsSync(minHookLicensePath)) {
  throw new Error('ライセンスファイルの生成元が見つかりません。');
}
const current = fs.readFileSync(licensePath, 'utf8');
const marker = '\n\n===== MinHook v1.3.4 (BSD 2-Clause) =====\n';
if (!current.includes('MinHook v1.3.4')) {
  fs.writeFileSync(licensePath, `${current.trimEnd()}${marker}${fs.readFileSync(minHookLicensePath, 'utf8').trim()}\n`, 'utf8');
}
const bridgeLicensePath = path.join(projectDirectory, 'licenses', 'WebMapBridge-MIT.txt');
if (!fs.existsSync(bridgeLicensePath)) throw new Error('WebMapBridgeのライセンスが見つかりません。');
const afterMinHook = fs.readFileSync(licensePath, 'utf8');
const bridgeMarker = '\n\n===== WebMapBridge-derived code (MIT) =====\n';
if (!afterMinHook.includes('WebMapBridge-derived code (MIT)')) {
  fs.writeFileSync(licensePath, `${afterMinHook.trimEnd()}${bridgeMarker}${fs.readFileSync(bridgeLicensePath, 'utf8').trim()}\n`, 'utf8');
}

const appLicensePath = path.join(projectDirectory, 'LICENSE');
if (!fs.existsSync(appLicensePath)) throw new Error('本アプリのライセンスが見つかりません。');
const afterBridge = fs.readFileSync(licensePath, 'utf8');
const appMarker = '\n\n===== WebMap Overlay (MIT) =====\n';
if (!afterBridge.includes('===== WebMap Overlay (MIT) =====')) {
  fs.writeFileSync(licensePath, `${afterBridge.trimEnd()}${appMarker}${fs.readFileSync(appLicensePath, 'utf8').trim()}\n`, 'utf8');
}
