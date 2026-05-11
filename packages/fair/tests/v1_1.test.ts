import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  validateManifest,
  isValidManifest,
  upgradeToV1_1,
  getDefaultManifest,
  signManifest,
  verifyManifest,
} from '../src';
import type { FairManifestV1_1, SignedFairManifest } from '../src';
import * as ed from '@noble/ed25519';

// ─── Deterministic test keys ────────────────────────────────────────────────

async function generateTestKeypair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array; did: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, did: `did:imajin:${Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}` };
}

function makeValidV1_1(overrides?: Partial<FairManifestV1_1>): FairManifestV1_1 {
  return {
    fair: '1.1',
    version: '1.1',
    id: 'asset_test123',
    type: 'image/png',
    owner: 'did:imajin:owner123',
    created: new Date().toISOString(),
    access: { type: 'public' },
    attribution: [
      { did: 'did:imajin:owner123', role: 'creator', share: 0.99 },
      { role: 'platform', name: 'Imajin', share: 0.01 },
    ],
    distribution: {
      reproduction: { mode: 'allowed' },
      streaming: { mode: 'allowed', price: { amount: 1, currency: 'USD' } },
      derivative: { mode: 'allow-with-attribution' },
      syndication: { mode: 'allow-with-attribution' },
    },
    transfer: { allowed: true, requiresAttribution: true, price: { amount: 100000, currency: 'USD' }, resaleRoyaltyBps: 500 },
    fees: [
      { role: 'protocol', name: 'MJN', rateBps: 100, fixedCents: 0 },
      { role: 'node', name: 'Node', rateBps: 50, fixedCents: 0 },
      { role: 'buyer_credit', name: 'Buyer Credit', rateBps: 25, fixedCents: 0 },
      { role: 'scope', name: 'Scope', rateBps: 25, fixedCents: 0 },
    ],
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    tipping: { enabled: true },
    ...overrides,
  };
}

// ─── D1: canonicalize ───────────────────────────────────────────────────────

describe('canonicalize', () => {
  it('produces the same output for the same input', () => {
    const obj = { b: 2, a: 1 };
    expect(canonicalize(obj)).toBe(canonicalize(obj));
  });

  it('is invariant to key ordering', () => {
    const a = { z: 1, a: 2, m: { c: 3, b: 4 } };
    const b = { a: 2, m: { b: 4, c: 3 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('produces no whitespace', () => {
    const obj = { a: 1, b: [2, 3] };
    const out = canonicalize(obj);
    expect(out).not.toMatch(/\s/);
  });

  it('handles null and nested objects', () => {
    const obj = { a: null, b: { c: true, d: 'hello' } };
    expect(canonicalize(obj)).toBe('{"a":null,"b":{"c":true,"d":"hello"}}');
  });
});

// ─── D1: validateManifest (v1.1) ────────────────────────────────────────────

describe('validateManifest v1.1', () => {
  it('validates a correct manifest', () => {
    const manifest = makeValidV1_1();
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('isValidManifest type guard returns true', () => {
    expect(isValidManifest(makeValidV1_1())).toBe(true);
  });

  it('fails when fair is not 1.1', () => {
    const result = validateManifest(makeValidV1_1({ fair: '1.0' }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('fair'))).toBe(true);
  });

  it('fails when attribution shares do not sum to 1.0', () => {
    const result = validateManifest(
      makeValidV1_1({
        attribution: [
          { did: 'did:imajin:owner', role: 'creator', share: 0.5 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('sum'))).toBe(true);
  });

  it('accepts shares that sum to 1.0 within tolerance', () => {
    const result = validateManifest(
      makeValidV1_1({
        attribution: [
          { did: 'did:imajin:owner', role: 'creator', share: 0.333333 },
          { did: 'did:imajin:collab', role: 'collaborator', share: 0.333333 },
          { role: 'platform', name: 'Imajin', share: 0.333334 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when Money.amount is negative', () => {
    const result = validateManifest(
      makeValidV1_1({
        transfer: { allowed: true, price: { amount: -1, currency: 'USD' } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('fails when Money.amount is not an integer', () => {
    const result = validateManifest(
      makeValidV1_1({
        transfer: { allowed: true, price: { amount: 10.5, currency: 'USD' } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('integer'))).toBe(true);
  });

  it('fails when Money.currency is invalid', () => {
    const result = validateManifest(
      makeValidV1_1({
        transfer: { allowed: true, price: { amount: 100, currency: 'usd' } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('currency'))).toBe(true);
  });

  it('accepts MJNX as currency', () => {
    const result = validateManifest(
      makeValidV1_1({
        transfer: { allowed: true, price: { amount: 100, currency: 'MJNX' } },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when training.allowed is not boolean', () => {
    const result = validateManifest(
      makeValidV1_1({
        training: { allowed: 'false' as unknown as boolean },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('training.allowed'))).toBe(true);
  });

  it('fails when distribution mode is empty', () => {
    const result = validateManifest(
      makeValidV1_1({
        distribution: {
          reproduction: { mode: '' },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('mode'))).toBe(true);
  });

  it('validates distribution splits sum to 1.0', () => {
    const result = validateManifest(
      makeValidV1_1({
        distribution: {
          reproduction: {
            mode: 'allowed',
            splits: [
              { did: 'did:imajin:a', role: 'creator', share: 0.6 },
              { did: 'did:imajin:b', role: 'platform', share: 0.3 },
            ],
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('sum'))).toBe(true);
  });

  it('accepts settlement when present and valid', () => {
    const result = validateManifest(
      makeValidV1_1({
        settlement: {
          endpoint: 'https://custom.example.com/settle',
          schemes: ['stripe-link', 'mjnx-direct'],
          fallback: 'stripe-link',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts manifest without settlement field', () => {
    const manifest = makeValidV1_1();
    delete (manifest as Record<string, unknown>).settlement;
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
  });

  it('fails when settlement.endpoint is not a string', () => {
    const result = validateManifest(
      makeValidV1_1({
        settlement: { endpoint: 123 } as unknown as Record<string, unknown>,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('settlement.endpoint'))).toBe(true);
  });

  it('fails when settlement.schemes contains invalid scheme', () => {
    const result = validateManifest(
      makeValidV1_1({
        settlement: { schemes: ['stripe-link', 'bogus'] } as unknown as Record<string, unknown>,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid scheme'))).toBe(true);
  });

  it('fails when settlement.fallback is invalid', () => {
    const result = validateManifest(
      makeValidV1_1({
        settlement: { fallback: 'bogus' } as unknown as Record<string, unknown>,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('settlement.fallback'))).toBe(true);
  });
});

// ─── D1: upgradeToV1_1 ──────────────────────────────────────────────────────

describe('upgradeToV1_1', () => {
  it('is idempotent on already-v1.1 input', () => {
    const v1_1 = makeValidV1_1();
    const result = upgradeToV1_1(v1_1);
    expect(result).toBe(v1_1);
  });

  it('upgrades a minimal v1.0 manifest', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: { type: 'public' },
      attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1.0 }],
      transfer: { allowed: false },
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.version).toBe('1.1');
    expect(result.attribution).toHaveLength(2);
    expect(result.attribution[0].share).toBe(0.99);
    expect(result.attribution[1].share).toBe(0.01);
    expect(result.training?.allowed).toBe(false);
    expect(result.commercial?.allowed).toBe(false);
    expect(result.distribution?.reproduction?.mode).toBe('allowed');
  });

  it('preserves existing multi-party attribution', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: { type: 'public' },
      attribution: [
        { did: 'did:imajin:a', role: 'creator', share: 0.7 },
        { did: 'did:imajin:b', role: 'collaborator', share: 0.3 },
      ],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.attribution).toHaveLength(2);
    expect(result.attribution[0].share).toBe(0.7);
    expect(result.attribution[1].share).toBe(0.3);
  });

  it('applies text-aware defaults for text/*', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'text/markdown',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1.0 }],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.distribution?.reproduction?.quote?.maxPercent).toBe(25);
    expect(result.distribution?.reproduction?.quote?.maxWords).toBe(200);
  });

  it('applies audio-aware defaults for audio/*', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'audio/mpeg',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1.0 }],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.distribution?.derivative?.sampling?.allowed).toBe('allow-with-share');
    expect(result.distribution?.derivative?.sampling?.share).toBe(0.05);
    expect(result.distribution?.derivative?.sync?.allowed).toBe('reserved');
  });

  it('applies video-aware defaults for video/*', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'video/mp4',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1.0 }],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.distribution?.derivative?.sync?.allowed).toBe('reserved');
  });

  // Regression: a single-creator v1.0 manifest with a non-1.0 share
  // (e.g. 0.52 from misuse of the share field) used to be migrated
  // verbatim, producing a v1.1 manifest that failed the totals=100%
  // validator and became uneditable in the UI.
  it('normalizes a single-creator entry with a bogus share to the 99/1 default', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 0.52 }],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.attribution).toHaveLength(2);
    const total = result.attribution.reduce((s: number, e) => s + e.share, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    expect(result.attribution[0].did).toBe('did:imajin:owner');
    expect(result.attribution[0].share).toBe(0.99);
  });

  it('treats percentage-style multi-entry attribution (sum 100) as fractions', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [
        { did: 'did:imajin:a', role: 'creator', share: 70 },
        { did: 'did:imajin:b', role: 'collaborator', share: 30 },
      ],
    };
    const result = upgradeToV1_1(v1_0 as any);
    const total = result.attribution.reduce((s: number, e) => s + e.share, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    expect(result.attribution[0].share).toBeCloseTo(0.7, 6);
    expect(result.attribution[1].share).toBeCloseTo(0.3, 6);
  });

  it('proportionally scales multi-entry attribution that does not sum to 1', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [
        { did: 'did:imajin:a', role: 'creator', share: 0.3 },
        { did: 'did:imajin:b', role: 'collaborator', share: 0.2 },
      ],
    };
    const result = upgradeToV1_1(v1_0 as any);
    const total = result.attribution.reduce((s: number, e) => s + e.share, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    // Ratio preserved: 0.3:0.2 → 0.6:0.4
    expect(result.attribution[0].share).toBeCloseTo(0.6, 6);
    expect(result.attribution[1].share).toBeCloseTo(0.4, 6);
  });

  it('falls back to 99/1 default when v1.0 attribution is empty', () => {
    const v1_0 = {
      fair: '1.0',
      id: 'asset_old',
      type: 'image/png',
      owner: 'did:imajin:owner',
      created: '2024-01-01T00:00:00Z',
      access: 'public',
      attribution: [],
    };
    const result = upgradeToV1_1(v1_0 as any);
    expect(result.attribution).toHaveLength(2);
    expect(result.attribution[0].share).toBe(0.99);
    expect(result.attribution[1].share).toBe(0.01);
  });
});

// ─── D2: sign/verify ────────────────────────────────────────────────────────

describe('signManifest / verifyManifest v1.1', () => {
  it('round-trips sign → verify successfully', async () => {
    const { privateKey, publicKey, did } = await generateTestKeypair();
    const manifest = makeValidV1_1();
    const signed = await signManifest(manifest, { did, privateKey });

    expect(signed.signature).toBeDefined();
    expect(signed.signature.alg).toBe('ed25519');
    expect(signed.signature.signer).toBe(did);
    expect(signed.signature.signedAt).toBeTruthy();

    const result = await verifyManifest(signed, async () => publicKey);
    expect(result).toEqual({ ok: true });
  });

  it('fails verification after tampering', async () => {
    const { privateKey, publicKey, did } = await generateTestKeypair();
    const manifest = makeValidV1_1();
    const signed = await signManifest(manifest, { did, privateKey });

    signed.owner = 'did:imajin:attacker';

    const result = await verifyManifest(signed, async () => publicKey);
    expect(result).toEqual({ ok: false, reason: 'Signature verification failed' });
  });

  it('fails verification with wrong key', async () => {
    const { privateKey, did } = await generateTestKeypair();
    const wrongKeypair = await generateTestKeypair();
    const manifest = makeValidV1_1();
    const signed = await signManifest(manifest, { did, privateKey });

    const result = await verifyManifest(signed, async () => wrongKeypair.publicKey);
    expect(result).toEqual({ ok: false, reason: 'Signature verification failed' });
  });

  it('fails verification when signature is missing', async () => {
    const manifest = makeValidV1_1();
    const result = await verifyManifest(manifest as SignedFairManifest, async () => new Uint8Array(32));
    expect('valid' in result && result.valid === false).toBe(true);
  });
});

// ─── D3: getDefaultManifest ─────────────────────────────────────────────────

describe('getDefaultManifest', () => {
  it('produces a valid v1.1 manifest for image/*', () => {
    const manifest = getDefaultManifest('image/png', 'did:imajin:owner');
    manifest.id = 'asset_img_001';
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(manifest.version).toBe('1.1');
    expect(manifest.training?.allowed).toBe(false);
  });

  it('produces a valid v1.1 manifest for text/*', () => {
    const manifest = getDefaultManifest('text/markdown', 'did:imajin:owner');
    manifest.id = 'asset_txt_001';
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(manifest.distribution?.reproduction?.quote?.maxPercent).toBe(25);
    expect(manifest.distribution?.reproduction?.quote?.maxWords).toBe(200);
  });

  it('produces a valid v1.1 manifest for audio/*', () => {
    const manifest = getDefaultManifest('audio/mpeg', 'did:imajin:owner');
    manifest.id = 'asset_aud_001';
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(manifest.distribution?.derivative?.sampling?.allowed).toBe('allow-with-share');
    expect(manifest.distribution?.derivative?.sync?.allowed).toBe('reserved');
  });

  it('produces a valid v1.1 manifest for video/*', () => {
    const manifest = getDefaultManifest('video/mp4', 'did:imajin:owner');
    manifest.id = 'asset_vid_001';
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(manifest.distribution?.derivative?.sync?.allowed).toBe('reserved');
  });

  it('has attribution shares summing to 1.0', () => {
    const manifest = getDefaultManifest('image/png', 'did:imajin:owner');
    const sum = manifest.attribution.reduce((s, e) => s + e.share, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('has training.allowed === false everywhere', () => {
    for (const mime of ['image/png', 'text/plain', 'audio/mpeg', 'video/mp4', 'application/pdf']) {
      const manifest = getDefaultManifest(mime, 'did:imajin:owner');
      expect(manifest.training?.allowed).toBe(false);
    }
  });
});
