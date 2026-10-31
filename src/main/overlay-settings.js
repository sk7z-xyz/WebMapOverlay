const DEFAULT_OVERLAY_RATIO = 0.30;
const MIN_OVERLAY_RATIO = 0.10;
const MAX_OVERLAY_RATIO = 0.80;
const DEFAULT_MAP_ZOOM = 0.1;
const MIN_MAP_ZOOM = 0.005;
const MAX_MAP_ZOOM = 5;

function normalizeOverlayRatio(value) {
  const parsed = parseFiniteNumber(value, DEFAULT_OVERLAY_RATIO);
  return Number.isFinite(parsed)
    ? Math.max(MIN_OVERLAY_RATIO, Math.min(MAX_OVERLAY_RATIO, parsed))
    : DEFAULT_OVERLAY_RATIO;
}

function normalizeMapZoom(value) {
  const parsed = parseFiniteNumber(value, DEFAULT_MAP_ZOOM);
  return Number.isFinite(parsed)
    ? Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, parsed))
    : DEFAULT_MAP_ZOOM;
}

function parseFiniteNumber(value, fallback) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  DEFAULT_MAP_ZOOM,
  DEFAULT_OVERLAY_RATIO,
  MAX_MAP_ZOOM,
  MAX_OVERLAY_RATIO,
  MIN_MAP_ZOOM,
  MIN_OVERLAY_RATIO,
  normalizeMapZoom,
  normalizeOverlayRatio,
};
