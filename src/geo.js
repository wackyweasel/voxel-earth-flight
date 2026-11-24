// Spherical Earth in a Y-up frame: +Y = north pole, lon 0 on +X, east = (-sin lon, 0, -cos lon).
export const R = 6378137;
export const DEG = Math.PI / 180;
export const MAX_LAT = 85.0511287798;

export const G = 32; // voxel columns per tile edge

// Vertical exaggeration so relief stays visible from orbit; 1 (true scale) from z9 down.
export function heightScale(z) {
  return z >= 9 ? 1 : 1 + (9 - z) * 0.4;
}

export function tileToLon(fx, n) {
  return (fx / n) * 360 - 180;
}

export function tileToLat(fy, n) {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) / DEG;
}

export function llToDir(latDeg, lonDeg, out = [0, 0, 0]) {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const c = Math.cos(la);
  out[0] = c * Math.cos(lo);
  out[1] = Math.sin(la);
  out[2] = -c * Math.sin(lo);
  return out;
}

export function dirToLat(x, y, z) {
  return Math.asin(Math.max(-1, Math.min(1, y / Math.hypot(x, y, z)))) / DEG;
}

export function dirToLon(x, z) {
  return Math.atan2(-z, x) / DEG;
}

// Fractional web-mercator coords (0..1) of a lat/lon.
export function llToMerc(latDeg, lonDeg) {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg));
  const s = Math.sin(lat * DEG);
  return {
    u: (lonDeg + 180) / 360,
    v: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}
