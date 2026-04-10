import { describe, it, expect } from 'vitest';
import {
  pearsonCorrelation,
  correlateBump,
  haversineDistance,
  BUMP_CORRELATION_THRESHOLD,
} from '../bump-correlation';

/**
 * Generate a synthetic bump waveform: a sharp spike with damped oscillation.
 * Models a real accelerometer impact (~30 samples at 60Hz = 500ms window).
 */
function syntheticBump(peakG: number, noiseLevel = 0.1, seed = 0): number[] {
  const samples = 30;
  const waveform: number[] = [];
  // Simple seeded PRNG (good enough for deterministic tests)
  let s = seed || 1;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s / 2147483647) - 0.5; };

  for (let i = 0; i < samples; i++) {
    // Baseline ~1g (gravity), spike at sample 12-15, damped after
    let val = 9.8; // gravity baseline
    const t = i - 12; // center spike at sample 12
    if (t >= 0 && t < 15) {
      // Damped impulse: peak * e^(-t/3) * cos(t)
      val += peakG * Math.exp(-t / 3) * Math.cos(t * 1.5);
    }
    val += rand() * noiseLevel;
    waveform.push(val);
  }
  return waveform;
}

/**
 * Generate the mirror-image waveform (Newton's third law).
 * The other phone experiences equal-and-opposite force relative to baseline.
 */
function mirrorBump(waveform: number[], baseline = 9.8, noiseLevel = 0.05, seed = 42): number[] {
  let s = seed;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s / 2147483647) - 0.5; };

  return waveform.map((val) => {
    const delta = val - baseline;
    return baseline - delta + rand() * noiseLevel;
  });
}

/** Generate random noise (no bump) */
function noisyBaseline(noiseLevel = 0.3, seed = 99): number[] {
  let s = seed;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s / 2147483647) - 0.5; };
  return Array.from({ length: 30 }, () => 9.8 + rand() * noiseLevel);
}

/** Generate a DIFFERENT bump (different timing/peak — two unrelated people bumping nearby) */
function differentBump(seed = 77): number[] {
  const samples = 30;
  const waveform: number[] = [];
  let s = seed;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s / 2147483647) - 0.5; };

  for (let i = 0; i < samples; i++) {
    let val = 9.8;
    // Spike at sample 8 (different timing), different shape
    const t = i - 8;
    if (t >= 0 && t < 12) {
      val += 6 * Math.exp(-t / 2) * Math.sin(t * 2);
    }
    val += rand() * 0.15;
    waveform.push(val);
  }
  return waveform;
}

// ─── Pearson correlation ───

describe('pearsonCorrelation', () => {
  it('returns 1 for identical arrays', () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(a, a)).toBeCloseTo(1.0, 5);
  });

  it('returns -1 for perfectly inverted arrays', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [-1, -2, -3, -4, -5];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('returns ~0 for uncorrelated arrays', () => {
    const a = [1, -1, 1, -1, 1, -1, 1, -1];
    const b = [1, 1, -1, -1, 1, 1, -1, -1];
    const r = pearsonCorrelation(a, b);
    expect(Math.abs(r)).toBeLessThan(0.3);
  });

  it('returns 0 for empty arrays', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  it('returns 0 for zero-variance arrays', () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

// ─── Haversine distance ───

describe('haversineDistance', () => {
  it('returns 0 for same point', () => {
    expect(haversineDistance(43.65, -79.38, 43.65, -79.38)).toBe(0);
  });

  it('returns ~111km for 1 degree latitude', () => {
    const d = haversineDistance(43, -79, 44, -79);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('returns <15m for nearby points at a venue', () => {
    // ~5m apart
    const d = haversineDistance(43.650000, -79.380000, 43.650045, -79.380000);
    expect(d).toBeLessThan(15);
    expect(d).toBeGreaterThan(3);
  });
});

// ─── Bump correlation (the real tests) ───

describe('correlateBump', () => {
  it('matches a bump with its mirror image (Newton\'s third law)', () => {
    const phoneA = syntheticBump(12, 0.1, 1);
    const phoneB = mirrorBump(phoneA, 9.8, 0.05, 42);
    const rotA = syntheticBump(4, 0.05, 10);
    const rotB = syntheticBump(4, 0.05, 10); // rotation is correlated, not inverted

    const score = correlateBump(phoneA, rotA, phoneB, rotB);
    expect(score).toBeGreaterThan(BUMP_CORRELATION_THRESHOLD);
  });

  it('matches with moderate noise', () => {
    const phoneA = syntheticBump(10, 0.5, 2);
    const phoneB = mirrorBump(phoneA, 9.8, 0.3, 55);
    const rotA = syntheticBump(3, 0.2, 20);
    const rotB = syntheticBump(3, 0.2, 20);

    const score = correlateBump(phoneA, rotA, phoneB, rotB);
    expect(score).toBeGreaterThan(BUMP_CORRELATION_THRESHOLD);
  });

  it('rejects noise vs noise (no bump)', () => {
    const a = noisyBaseline(0.3, 1);
    const b = noisyBaseline(0.3, 2);
    const rotA = noisyBaseline(0.1, 3);
    const rotB = noisyBaseline(0.1, 4);

    const score = correlateBump(a, rotA, b, rotB);
    expect(score).toBeLessThan(BUMP_CORRELATION_THRESHOLD);
  });

  it('rejects two different bumps (crowd scenario)', () => {
    const phoneA = syntheticBump(12, 0.1, 1);
    const unrelated = differentBump(77);
    const rotA = syntheticBump(4, 0.05, 10);
    const rotUnrelated = syntheticBump(3, 0.1, 88);

    const score = correlateBump(phoneA, rotA, unrelated, rotUnrelated);
    expect(score).toBeLessThan(BUMP_CORRELATION_THRESHOLD);
  });

  it('matches same-direction bumps (accelerationIncludingGravity mode)', () => {
    // Both phones report the same spike direction when using gravity-included data
    const phoneA = syntheticBump(12, 0.1, 1);
    const rotA = syntheticBump(4, 0.05, 10);

    const score = correlateBump(phoneA, rotA, phoneA, rotA);
    // Direct correlation should be high — same bump shape
    expect(score).toBeGreaterThan(BUMP_CORRELATION_THRESHOLD);
  });

  it('handles weak bumps (gentle tap)', () => {
    const phoneA = syntheticBump(3, 0.1, 5); // low peak
    const phoneB = mirrorBump(phoneA, 9.8, 0.05, 66);
    const rotA = syntheticBump(1, 0.05, 15);
    const rotB = syntheticBump(1, 0.05, 15);

    const score = correlateBump(phoneA, rotA, phoneB, rotB);
    // Should still match — Pearson doesn't care about magnitude, only shape
    expect(score).toBeGreaterThan(BUMP_CORRELATION_THRESHOLD);
  });
});
