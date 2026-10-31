function parseTrackerStatus(value) {
  const line = String(value || '').trim();
  const rect = line.match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)(?:,(\d+))?(?:,(0|1))?$/);
  if (rect) {
    return {
      type: 'rect',
      left: Number(rect[1]),
      top: Number(rect[2]),
      right: Number(rect[3]),
      bottom: Number(rect[4]),
      pid: Number(rect[5] || 0),
      active: rect[6] === undefined ? true : rect[6] === '1',
    };
  }
  if (line === 'exited') return { type: 'exited' };
  const none = line.match(/^none(?::(\d+))?$/);
  if (none) return { type: 'none', pid: Number(none[1] || 0) };
  const inactive = line.match(/^inactive(?::(\d+))?$/);
  if (inactive) return { type: 'inactive', pid: Number(inactive[1] || 0) };
  return null;
}

module.exports = { parseTrackerStatus };
