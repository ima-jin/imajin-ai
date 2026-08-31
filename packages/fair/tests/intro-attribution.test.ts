import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  INTRO_ATTRIBUTION_MANIFEST_TYPE,
  INTRO_ATTRIBUTION_ROLES,
  INTRO_MADE_ATTESTATION_TYPE,
  VALUE_REALIZED_ATTESTATION_TYPE,
  validateIntroAttributionSplitBps,
  isWithinAttributionWindow,
  validateIntroAttributionProvenance,
  buildIntroAttributionManifest,
  introAttributionSettlementChain,
  isIntroAttributionManifest,
  type AttestationFact,
} from '../src/intro-attribution';
import { validateManifest } from '../src/validate';

const MATCHMAKER = 'did:imajin:matchmaker';
const PARTY_A = 'did:imajin:alice';
const PARTY_B = 'did:imajin:bob';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('validateIntroAttributionSplitBps', () => {
  it('accepts the 70/15/15 default', () => {
    expect(validateIntroAttributionSplitBps(DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS)).toEqual({ ok: true });
  });

  it('accepts a custom split that sums to 10000', () => {
    const result = validateIntroAttributionSplitBps({ matchmakerBps: 5000, partyABps: 3000, partyBBps: 2000 });
    expect(result.ok).toBe(true);
  });

  it('rejects a split that does not sum to 10000', () => {
    const result = validateIntroAttributionSplitBps({ matchmakerBps: 5000, partyABps: 3000, partyBBps: 1000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must sum to 10000/);
  });

  it('rejects a negative share', () => {
    const result = validateIntroAttributionSplitBps({ matchmakerBps: -100, partyABps: 5100, partyBBps: 5000 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer share', () => {
    const result = validateIntroAttributionSplitBps({ matchmakerBps: 7000.5, partyABps: 1500, partyBBps: 1499.5 });
    expect(result.ok).toBe(false);
  });
});

describe('isWithinAttributionWindow', () => {
  const introMadeAt = '2026-01-01T00:00:00.000Z';

  it('is true immediately after intro_made', () => {
    expect(isWithinAttributionWindow({ introMadeAt, at: introMadeAt, windowDays: 365 })).toBe(true);
  });

  it('is true 8 months later, inside a 12-month window (the acceptance case)', () => {
    const at = new Date(new Date(introMadeAt).getTime() + 8 * 30 * DAY_MS).toISOString();
    expect(isWithinAttributionWindow({ introMadeAt, at, windowDays: DEFAULT_ATTRIBUTION_WINDOW_DAYS })).toBe(true);
  });

  it('is false once the window has elapsed', () => {
    const at = new Date(new Date(introMadeAt).getTime() + 400 * DAY_MS).toISOString();
    expect(isWithinAttributionWindow({ introMadeAt, at, windowDays: 365 })).toBe(false);
  });

  it('is false for a timestamp before intro_made (defensive)', () => {
    const at = new Date(new Date(introMadeAt).getTime() - DAY_MS).toISOString();
    expect(isWithinAttributionWindow({ introMadeAt, at, windowDays: 365 })).toBe(false);
  });

  it('is false for unparseable dates', () => {
    expect(isWithinAttributionWindow({ introMadeAt: 'not-a-date', windowDays: 365 })).toBe(false);
  });
});

describe('buildIntroAttributionManifest', () => {
  const introMadeAt = '2026-01-01T00:00:00.000Z';
  const provenance = [
    { attestationId: 'att_intro_proposed', type: 'intro_proposed' },
    { attestationId: 'att_intro_made', type: INTRO_MADE_ATTESTATION_TYPE },
  ];

  it('produces a valid v1.1 manifest with the default 70/15/15 split', () => {
    const manifest = buildIntroAttributionManifest({
      id: 'fair_intro_1',
      matchmakerDid: MATCHMAKER,
      partyADid: PARTY_A,
      partyBDid: PARTY_B,
      provenance,
      introMadeAt,
    });

    expect(manifest.type).toBe(INTRO_ATTRIBUTION_MANIFEST_TYPE);
    expect(manifest.provenance).toEqual(provenance);
    expect(manifest.attribution).toHaveLength(3);

    const matchmakerEntry = manifest.attribution.find((e) => e.role === INTRO_ATTRIBUTION_ROLES.MATCHMAKER);
    const partyAEntry = manifest.attribution.find((e) => e.role === INTRO_ATTRIBUTION_ROLES.PARTY_A);
    const partyBEntry = manifest.attribution.find((e) => e.role === INTRO_ATTRIBUTION_ROLES.PARTY_B);
    expect(matchmakerEntry?.share).toBeCloseTo(0.7, 10);
    expect(partyAEntry?.share).toBeCloseTo(0.15, 10);
    expect(partyBEntry?.share).toBeCloseTo(0.15, 10);

    const shareSum = manifest.attribution.reduce((sum, e) => sum + e.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);

    // Template validation (#1886 acceptance): a built manifest passes the
    // shared .fair validator, including the new provenance[] shape check.
    const validation = validateManifest(manifest);
    expect(validation.ok).toBe(true);
  });

  it('honors a custom split consented at grant time', () => {
    const manifest = buildIntroAttributionManifest({
      id: 'fair_intro_2',
      matchmakerDid: MATCHMAKER,
      partyADid: PARTY_A,
      partyBDid: PARTY_B,
      split: { matchmakerBps: 5000, partyABps: 2500, partyBBps: 2500 },
      provenance,
      introMadeAt,
    });

    const matchmakerEntry = manifest.attribution.find((e) => e.role === INTRO_ATTRIBUTION_ROLES.MATCHMAKER);
    expect(matchmakerEntry?.share).toBeCloseTo(0.5, 10);
  });

  it('records the attribution window and introMadeAt in intent.constraints', () => {
    const manifest = buildIntroAttributionManifest({
      id: 'fair_intro_3',
      matchmakerDid: MATCHMAKER,
      partyADid: PARTY_A,
      partyBDid: PARTY_B,
      attributionWindowDays: 180,
      provenance,
      introMadeAt,
    });

    expect(manifest.intent?.constraints).toEqual({ attributionWindowDays: 180, introMadeAt });
  });

  it('throws for an invalid split rather than silently producing a broken manifest', () => {
    expect(() =>
      buildIntroAttributionManifest({
        id: 'fair_intro_bad',
        matchmakerDid: MATCHMAKER,
        partyADid: PARTY_A,
        partyBDid: PARTY_B,
        split: { matchmakerBps: 1000, partyABps: 1000, partyBBps: 1000 },
        provenance,
        introMadeAt,
      }),
    ).toThrow(/invalid split/);
  });
});

describe('introAttributionSettlementChain', () => {
  it('returns a chain compatible with resolveSettlementChain, summing to 1.0', () => {
    const chain = introAttributionSettlementChain({ matchmakerDid: MATCHMAKER, partyADid: PARTY_A, partyBDid: PARTY_B });
    const total = chain.reduce((sum, e) => sum + e.share, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(chain.map((e) => e.role).sort()).toEqual(['matchmaker', 'party_a', 'party_b']);
  });
});

describe('isIntroAttributionManifest', () => {
  it('is true only for the intro-attribution type', () => {
    expect(isIntroAttributionManifest({ type: INTRO_ATTRIBUTION_MANIFEST_TYPE })).toBe(true);
    expect(isIntroAttributionManifest({ type: 'media' })).toBe(false);
    expect(isIntroAttributionManifest(null)).toBe(false);
  });
});

describe('validateIntroAttributionProvenance — the money-rule trigger gate', () => {
  const introMadeAt = '2026-01-01T00:00:00.000Z';
  const introMadeFact: AttestationFact = { id: 'att_intro_made', type: INTRO_MADE_ATTESTATION_TYPE, issuedAt: introMadeAt };

  it('allows an on-platform settlement: intro facts only, no value_realized needed', () => {
    const provenance = [
      { attestationId: 'att_intro_proposed', type: 'intro_proposed' },
      { attestationId: introMadeFact.id, type: introMadeFact.type },
    ];
    const resolvedFacts: AttestationFact[] = [
      { id: 'att_intro_proposed', type: 'intro_proposed', issuedAt: introMadeAt },
      introMadeFact,
    ];

    const result = validateIntroAttributionProvenance({
      provenance,
      resolvedFacts,
      windowDays: 365,
      at: introMadeAt,
    });
    expect(result.ok).toBe(true);
  });

  it('the acceptance case: settlement 8 months later, inside a 12-month window, fires', () => {
    const at = new Date(new Date(introMadeAt).getTime() + 8 * 30 * DAY_MS).toISOString();
    const provenance = [{ attestationId: introMadeFact.id, type: introMadeFact.type }];

    const result = validateIntroAttributionProvenance({
      provenance,
      resolvedFacts: [introMadeFact],
      windowDays: 365,
      at,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when a provenance ref does not resolve to a real attestation', () => {
    const result = validateIntroAttributionProvenance({
      provenance: [{ attestationId: 'att_missing', type: INTRO_MADE_ATTESTATION_TYPE }],
      resolvedFacts: [],
      windowDays: 365,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/does not exist/);
  });

  it('rejects when no intro_made fact anchors the window', () => {
    const result = validateIntroAttributionProvenance({
      provenance: [{ attestationId: 'att_consent', type: 'consent_given' }],
      resolvedFacts: [{ id: 'att_consent', type: 'consent_given', issuedAt: introMadeAt }],
      windowDays: 365,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/anchor the attribution window/);
  });

  it('rejects a unilateral (pending) value_realized claim — the money rule', () => {
    const valueRealizedFact: AttestationFact = {
      id: 'att_value_realized',
      type: VALUE_REALIZED_ATTESTATION_TYPE,
      issuedAt: introMadeAt,
      attestationStatus: 'pending',
    };
    const result = validateIntroAttributionProvenance({
      provenance: [
        { attestationId: introMadeFact.id, type: introMadeFact.type },
        { attestationId: valueRealizedFact.id, type: valueRealizedFact.type },
      ],
      resolvedFacts: [introMadeFact, valueRealizedFact],
      windowDays: 365,
      at: introMadeAt,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/countersigned \(bilateral\)/);
  });

  it('rejects a declined (disputed) value_realized claim', () => {
    const valueRealizedFact: AttestationFact = {
      id: 'att_value_realized',
      type: VALUE_REALIZED_ATTESTATION_TYPE,
      issuedAt: introMadeAt,
      attestationStatus: 'declined',
    };
    const result = validateIntroAttributionProvenance({
      provenance: [
        { attestationId: introMadeFact.id, type: introMadeFact.type },
        { attestationId: valueRealizedFact.id, type: valueRealizedFact.type },
      ],
      resolvedFacts: [introMadeFact, valueRealizedFact],
      windowDays: 365,
      at: introMadeAt,
    });
    expect(result.ok).toBe(false);
  });

  it('allows a countersigned (bilateral) value_realized claim — off-platform trigger fires', () => {
    const valueRealizedFact: AttestationFact = {
      id: 'att_value_realized',
      type: VALUE_REALIZED_ATTESTATION_TYPE,
      issuedAt: introMadeAt,
      attestationStatus: 'bilateral',
    };
    const result = validateIntroAttributionProvenance({
      provenance: [
        { attestationId: introMadeFact.id, type: introMadeFact.type },
        { attestationId: valueRealizedFact.id, type: valueRealizedFact.type },
      ],
      resolvedFacts: [introMadeFact, valueRealizedFact],
      windowDays: 365,
      at: introMadeAt,
    });
    expect(result.ok).toBe(true);
  });

  it('window expiry stops new attribution once past the declared window', () => {
    const at = new Date(new Date(introMadeAt).getTime() + 400 * DAY_MS).toISOString();
    const result = validateIntroAttributionProvenance({
      provenance: [{ attestationId: introMadeFact.id, type: introMadeFact.type }],
      resolvedFacts: [introMadeFact],
      windowDays: 365,
      at,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/attribution window has expired/);
  });

  it('grant expiry does not sever attribution inside the window: gate only looks at facts and the window, never at grant status', () => {
    // The gate function takes no grant/expiry input at all — a caller who
    // fetches an EXPIRED grant's declared terms (split/window) still gets a
    // successful gate result as long as the intro-made fact is within the
    // window it declared. Nothing here treats the grant's own expiry as
    // relevant, which is the point (#1886 invariant 8).
    const at = new Date(new Date(introMadeAt).getTime() + 8 * 30 * DAY_MS).toISOString();
    const result = validateIntroAttributionProvenance({
      provenance: [{ attestationId: introMadeFact.id, type: introMadeFact.type }],
      resolvedFacts: [introMadeFact],
      windowDays: 365, // sourced from the (possibly now-expired) grant's declared terms
      at,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty provenance array', () => {
    const result = validateIntroAttributionProvenance({ provenance: [], resolvedFacts: [], windowDays: 365 });
    expect(result.ok).toBe(false);
  });
});
