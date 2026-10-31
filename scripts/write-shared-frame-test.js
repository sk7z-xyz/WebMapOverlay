'use strict';

const nativeBridge = require('../src/main/native-bridge');

const width = 256;
const height = 256;
const holdArgument = process.argv.find((argument) => argument.startsWith('--hold-ms='));
const requestedHoldMs = holdArgument ? Number(holdArgument.slice('--hold-ms='.length)) : 30000;
if (!Number.isFinite(requestedHoldMs) || requestedHoldMs < 0) {
  throw new Error('--hold-msには0以上の数値を指定してください。');
}
const holdMs = Math.min(Math.floor(requestedHoldMs), 60000);
const buffer = Buffer.alloc(width * height * 4);

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const cell = ((x >> 5) + (y >> 5)) & 1;
    const offset = (y * width + x) * 4;
    buffer[offset] = cell ? 0x20 : 0xE0;
    buffer[offset + 1] = cell ? 0xD0 : 0x20;
    buffer[offset + 2] = cell ? 0xE0 : 0x20;
    buffer[offset + 3] = 0xFF;
  }
}

nativeBridge.initialize();
if (!nativeBridge.frame(buffer, width, height, width * 4)) {
  throw new Error('共有フレームを書き込めませんでした。');
}
if (!nativeBridge.control(true, 0.30, 0.30, 0, true)) {
  throw new Error('共有制御情報を書き込めませんでした。');
}
process.stdout.write('SHARED_FRAME_READY\n');

let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  clearTimeout(holdTimer);
  process.exitCode = 0;
};
process.once('SIGINT', finish);
process.once('SIGTERM', finish);
const holdTimer = setTimeout(finish, holdMs);
