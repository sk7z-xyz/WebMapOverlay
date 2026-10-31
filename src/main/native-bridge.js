const fs = require('fs');
const path = require('path');
const {assertNoSymlinkPath} = require('./path-safety');
const appPaths = require('./app-paths');

let writer;
let writeFrame;
let writeControl;
let resetControl;

function loadNativeWriter() {
  if (writer) return writer;
  let koffi;
  try { koffi = require('koffi'); }
  catch (error) {
    console.error('共有メモリの依存関係を読み込めません:', error);
    throw new Error('共有メモリの依存関係を読み込めません。');
  }
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'WebMapOverlayWriter.dll'),
    path.join(appPaths.nativeBuild, 'WebMapOverlayWriter.dll'),
  ].filter(Boolean);
  const dllPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!dllPath) throw new Error('共有メモリwriterが見つかりません。アプリを再インストールしてください。');
  try {
    assertNoSymlinkPath(dllPath);
    writer = koffi.load(dllPath);
    writeFrame = writer.func('int WmoWriteFrame(const void *data, uint32_t size, uint32_t width, uint32_t height, uint32_t stride)');
    writeControl = writer.func('int WmoWriteControl(uint32_t visible, float ratio, float opacity, uint32_t anchor, uint32_t gameActive)');
    resetControl = writer.func('int WmoResetControl()');
    const initialize = writer.func('int WmoInitialize()');
    if (!initialize()) throw new Error('共有メモリを初期化できません。');
  } catch (error) {
    writer = null;
    console.error('共有メモリの初期化に失敗しました:', error);
    throw new Error('共有メモリの初期化に失敗しました。');
  }
  return writer;
}

function initialize() {
  loadNativeWriter();
  return true;
}

function frame(buffer, width, height, stride = width * 4) {
  loadNativeWriter();
  return Boolean(writeFrame(buffer, buffer.length, width, height, stride));
}

function control(visible, ratio, opacity, anchor, gameActive) {
  loadNativeWriter();
  return Boolean(writeControl(visible ? 1 : 0, ratio, opacity, anchor, gameActive ? 1 : 0));
}

function reset() {
  if (!writer) return true;
  return Boolean(resetControl());
}

module.exports = { initialize, frame, control, reset };
