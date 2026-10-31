const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTrackerStatus } = require('../src/main/tracker-status');

const inactive = parseTrackerStatus('100,200,900,1000,4321,0');
assert.deepStrictEqual(inactive, {
  type: 'rect', left: 100, top: 200, right: 900, bottom: 1000, pid: 4321, active: false,
});

const active = parseTrackerStatus('100,200,900,1000,4321,1');
assert.strictEqual(active.active, true);
assert.strictEqual(active.pid, 4321);

// 旧トラッカーの5項目形式も、従来どおりアクティブ矩形として受け付ける。
assert.strictEqual(parseTrackerStatus('1,2,3,4,99').active, true);
assert.strictEqual(parseTrackerStatus('inactive:99').type, 'inactive');
assert.strictEqual(parseTrackerStatus('none:99').type, 'none');
assert.strictEqual(parseTrackerStatus('not-a-status'), null);

const trackerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window-tracker-script.js'), 'utf8');
assert.match(trackerSource, /\$activeFlag = if \(\$active\) \{ 1 \} else \{ 0 \}/);
assert.match(trackerSource, /\$windowPid,\$activeFlag/);

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
assert.match(mainSource, /overlayMode === 'injection' \|\| trackerStatus\.active/);
assert.match(mainSource, /!wasAvailable \|\| previousPid !== currentStormworksPid/);
assert.doesNotMatch(mainSource, /!wasActive \|\| previousPid !== currentStormworksPid/);
assert.doesNotMatch(
  mainSource,
  /currentStormworksPid && stormworksWindowAvailable\s*\n\s*&& gameActive && lastInjectedPid !== currentStormworksPid/,
);

console.log('inactive injection tracker protocol: ok');
