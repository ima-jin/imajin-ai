/**
 * Bump correlation utilities — waveform cross-correlation + haversine distance
 */

/**
 * Pearson correlation coefficient between two arrays.
 * Returns 0 if either array is empty or has zero variance.
 */
export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }

  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Haversine distance between two lat/lng points in metres.
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000; // Earth radius, metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Correlate two bump events.
 *
 * Newton's third law: the two phones experience equal-and-opposite force,
 * so we invert phone A's waveform before computing Pearson correlation with B.
 * High positive correlation after inversion → genuine physical collision.
 *
 * Combined score = 0.7 * accel_score + 0.3 * rotation_score
 */
export function correlateBump(
  waveformA: number[],
  rotationA: number[],
  waveformB: number[],
  rotationB: number[],
): number {
  const invertedA = waveformA.map((x) => -x);
  const accelScore = pearsonCorrelation(invertedA, waveformB);
  const rotationScore = pearsonCorrelation(rotationA, rotationB);
  return 0.7 * accelScore + 0.3 * rotationScore;
}

export const BUMP_CORRELATION_THRESHOLD = 0.7;
export const BUMP_MATCH_WINDOW_MS = 2_000;   // ±2 s
export const BUMP_LOCATION_RADIUS_M = 10;    // ±10 m
