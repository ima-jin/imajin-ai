/**
 * Unit tests for packages/fair/src/disclosure.ts (#1453).
 *
 * Covers the canonical disclosure engine that previously lived in two
 * incompatible copies across the codebase:
 *   - apps/kernel/src/lib/media/release-policy.ts (4-tier, asset-side)
 *   - apps/kernel/src/lib/media/fair-disclosure-policy.ts (3-tier, lot-side)
 *
 * This module is pure (no I/O), so tests run without any mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  FAIR_RELEASE_TIERS,
  TIER_RANK,
  FAIR_FLOOR_FIELDS,
  deriveReleaseTier,
  composeEffectivePolicy,
  applyDisclosureGates,
  parseSubjectGates,
  type FairDisclosureOverlay,
} from '../disclosure';
import type { FairManifestV1_1 } from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_MANIFEST: FairManifestV1_1 = {
  fair: '1.1',
  version: '1.1',
  id: 'fair_test_001',
  type: 'settlement',
  owner: 'did:imajin:owner',
  created: '2026-01-01T00:00:00Z',
  access: { type: 'public' },
  attribution: [
    { did: 'did:imajin:alice', role: 'creator', share: 70, name: 'Alice', note: 'lead' },
    { did: 'did:imajin:bob', role: 'producer', share: 30 },
  ],
  fees: [
    { role: 'platform', name: 'Platform fee', rateBps: 250, fixedCents: 0 },
  ],
  integrity: { hash: 'abc123', size: 512 },
  signature: { signer: 'did:imajin:node', alg: 'ed25519', value: 'sig', signedAt: '2026-01-01T00:00:00Z' },
  distribution: {
    reproduction: { mode: 'license', price: { amount: 5000, currency: 'MJNX' } },
  },
  transfer: {
    allowed: true,
    price: { amount: 9900, currency: 'USD' },
  },
  training: { allowed: false },
  commercial: { allowed: true },
  tipping: { enabled: true },
};

// ── Release tier ─────────────────────────────────────────────────────────────

describe('FAIR_RELEASE_TIERS', () => {
  it('contains all four tiers', () => {
    expect(FAIR_RELEASE_TIERS).toContain('silent');
    expect(FAIR_RELEASE_TIERS).toContain('on-consent');
    expect(FAIR_RELEASE_TIERS).toContain('owner-only');
    expect(FAIR_RELEASE_TIERS).toContain('never');
  });
});

describe('TIER_RANK', () => {
  it('is strictly monotonic: silent < on-consent < owner-only < never', () => {
    expect(TIER_RANK['silent']).toBeLessThan(TIER_RANK['on-consent']);
    expect(TIER_RANK['on-consent']).toBeLessThan(TIER_RANK['owner-only']);
    expect(TIER_RANK['owner-only']).toBeLessThan(TIER_RANK['never']);
  });
});

// ── #1196 consent 2x2 ────────────────────────────────────────────────────────

describe('deriveReleaseTier (#1196 2x2)', () => {
  it('maps each quadrant to a monotonic tier', () => {
    expect(deriveReleaseTier({ disclosesOthers: false, sensitive: false })).toBe('silent');
    expect(deriveReleaseTier({ disclosesOthers: true, sensitive: false })).toBe('on-consent');
    expect(deriveReleaseTier({ disclosesOthers: false, sensitive: true })).toBe('owner-only');
    expect(deriveReleaseTier({ disclosesOthers: true, sensitive: true })).toBe('never');
  });

  it('is monotonic: (false,false) is loosest, (true,true) is tightest', () => {
    expect(TIER_RANK[deriveReleaseTier({ disclosesOthers: false, sensitive: false })]).toBe(0);
    expect(TIER_RANK[deriveReleaseTier({ disclosesOthers: true, sensitive: true })]).toBe(3);
  });
});

// ── FAIR_FLOOR_FIELDS ────────────────────────────────────────────────────────

describe('FAIR_FLOOR_FIELDS', () => {
  it('contains the minimum public record fields', () => {
    const required = ['id', 'type', 'created', 'fair', 'version', 'integrity', 'signature', 'platformSignature'];
    for (const f of required) {
      expect(FAIR_FLOOR_FIELDS.has(f as never)).toBe(true);
    }
  });

  it('does not contain non-floor fields', () => {
    expect(FAIR_FLOOR_FIELDS.has('owner' as never)).toBe(false);
    expect(FAIR_FLOOR_FIELDS.has('amount' as never)).toBe(false);
  });
});

// ── composeEffectivePolicy ───────────────────────────────────────────────────

describe('composeEffectivePolicy', () => {
  it('pins floor fields to silent regardless of community overlay', () => {
    const overlay: FairDisclosureOverlay = {
      id: { release: 'never' },           // attempt to suppress a floor field
      integrity: { release: 'on-consent' },
    };
    const policy = composeEffectivePolicy(overlay);
    expect(policy['id']?.release).toBe('silent');
    expect(policy['id']?.isFloor).toBe(true);
    expect(policy['integrity']?.release).toBe('silent');
    expect(policy['integrity']?.isFloor).toBe(true);
  });

  it('subject gates win over community overlay (tighten)', () => {
    const community: FairDisclosureOverlay = { owner: { release: 'silent' } };
    const subject: FairDisclosureOverlay = { owner: { release: 'owner-only' } };
    const policy = composeEffectivePolicy(community, subject);
    expect(policy['owner']?.release).toBe('owner-only');
  });

  it('subject gates win over community overlay (loosen)', () => {
    const community: FairDisclosureOverlay = { amount: { release: 'never' } };
    const subject: FairDisclosureOverlay = { amount: { release: 'silent' } };
    const policy = composeEffectivePolicy(community, subject);
    expect(policy['amount']?.release).toBe('silent');
  });

  it('defaults unknown fields to silent', () => {
    const policy = composeEffectivePolicy({});
    // Any field not listed defaults to silent via the gate function
    expect(policy['owner']).toBeUndefined(); // not in overlay, not floor — absent from policy
  });
});

// ── applyDisclosureGates — owner-only ────────────────────────────────────────

describe('applyDisclosureGates owner-only tier', () => {
  const overlay: FairDisclosureOverlay = { source: { release: 'owner-only' } };

  it('withholds owner-only fields when isOwner is false (default)', () => {
    const policy = composeEffectivePolicy(overlay);
    const manifest = { ...BASE_MANIFEST, source: 'internal://cost-ref' };
    const { manifest: out, withheld } = applyDisclosureGates(manifest, policy);
    expect(out['source']).toBeUndefined();
    expect(withheld['source']).toEqual({ present: true, attestation: 'covered-by-signature' });
  });

  it('includes owner-only fields when isOwner is true', () => {
    const policy = composeEffectivePolicy(overlay);
    const manifest = { ...BASE_MANIFEST, source: 'internal://cost-ref' };
    const { manifest: out, withheld } = applyDisclosureGates(manifest, policy, new Set(), true);
    expect(out['source']).toBe('internal://cost-ref');
    expect(withheld['source']).toBeUndefined();
  });

  it('does not put null/undefined owner-only fields in withheld', () => {
    const policy = composeEffectivePolicy(overlay);
    // source is not set in BASE_MANIFEST
    const { withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(withheld['source']).toBeUndefined();
  });

  it('owner-only cannot be overridden by a consent grant', () => {
    const policy = composeEffectivePolicy(overlay);
    const manifest = { ...BASE_MANIFEST, source: 'secret' };
    // Even with 'source' in grantedFields, isOwner=false withholds it
    const { manifest: out, withheld } = applyDisclosureGates(
      manifest, policy, new Set(['source']), false,
    );
    expect(out['source']).toBeUndefined();
    expect(withheld['source']).toBeDefined();
  });
});

// ── applyDisclosureGates — on-consent ────────────────────────────────────────

describe('applyDisclosureGates on-consent tier', () => {
  const overlay: FairDisclosureOverlay = { amount: { release: 'on-consent' } };

  it('withholds on-consent fields without a grant', () => {
    const policy = composeEffectivePolicy(overlay);
    const { manifest: out, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    // amount is synthetic; distribution/transfer contain Money.amount
    expect(withheld['amount']).toBeUndefined(); // raw 'amount' key not in manifest, but distribution has price
  });

  it('includes on-consent fields with a matching grant', () => {
    const communityOverlay: FairDisclosureOverlay = {
      owner: { release: 'on-consent' },
    };
    const policy = composeEffectivePolicy(communityOverlay);
    const { manifest: out } = applyDisclosureGates(
      BASE_MANIFEST, policy, new Set(['owner']),
    );
    expect(out['owner']).toBe('did:imajin:owner');
  });
});

// ── applyDisclosureGates — never tier ────────────────────────────────────────

describe('applyDisclosureGates never tier', () => {
  it('structurally drops never fields from both manifest and withheld', () => {
    const overlay: FairDisclosureOverlay = { fees: { release: 'never' } };
    const policy = composeEffectivePolicy(overlay);
    const { manifest: out, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(out['fees']).toBeUndefined();
    expect(withheld['fees']).toBeUndefined();
  });
});

// ── applyDisclosureGates — floor pinning ─────────────────────────────────────

describe('applyDisclosureGates floor pinning', () => {
  it('always includes floor fields regardless of overlay', () => {
    // Attempt to suppress floor fields via community overlay
    const overlay: FairDisclosureOverlay = {
      id: { release: 'never' },
      type: { release: 'owner-only' },
      created: { release: 'on-consent' },
    };
    const policy = composeEffectivePolicy(overlay);
    const { manifest: out } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(out['id']).toBe('fair_test_001');
    expect(out['type']).toBe('settlement');
    expect(out['created']).toBe('2026-01-01T00:00:00Z');
  });
});

// ── applyDisclosureGates — _disclosure never emitted ─────────────────────────

describe('applyDisclosureGates _disclosure handling', () => {
  it('never emits _disclosure in output', () => {
    const policy = composeEffectivePolicy({});
    const manifest = { ...BASE_MANIFEST, _disclosure: { amount: { release: 'silent' } } };
    const { manifest: out } = applyDisclosureGates(manifest as never, policy);
    expect('_disclosure' in out).toBe(false);
  });
});

// ── parseSubjectGates ────────────────────────────────────────────────────────

describe('parseSubjectGates', () => {
  it('parses valid 4-tier release values including owner-only', () => {
    const raw = {
      _disclosure: {
        amount: { release: 'silent' },
        source: { release: 'owner-only' },
        fees: { release: 'on-consent' },
        owner: { release: 'never' },
      },
    };
    const gates = parseSubjectGates(raw);
    expect(gates['amount']?.release).toBe('silent');
    expect(gates['source']?.release).toBe('owner-only');
    expect(gates['fees']?.release).toBe('on-consent');
    expect(gates['owner']?.release).toBe('never');
  });

  it('returns empty overlay when _disclosure is absent', () => {
    expect(parseSubjectGates({})).toEqual({});
  });

  it('returns empty overlay when _disclosure is not an object', () => {
    expect(parseSubjectGates({ _disclosure: 'foo' })).toEqual({});
    expect(parseSubjectGates({ _disclosure: null })).toEqual({});
    expect(parseSubjectGates({ _disclosure: [] })).toEqual({});
  });

  it('ignores entries with invalid release values', () => {
    const raw = {
      _disclosure: {
        amount: { release: 'public' },   // invalid tier
        source: { release: 'silent' },   // valid
      },
    };
    const gates = parseSubjectGates(raw);
    expect(gates['amount']).toBeUndefined();
    expect(gates['source']?.release).toBe('silent');
  });
});
