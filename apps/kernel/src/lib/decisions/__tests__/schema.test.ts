/**
 * Tests for the DecisionCard v1 schema (#2315): structural validation and
 * the canonical `contentHash` — must be stable across re-renders and cover
 * everything except `ruling`.
 */
import { describe, it, expect } from 'vitest';
import {
  createDecisionCard,
  computeDecisionCardContentHash,
  validateDecisionCardInput,
  type DecisionCardInput,
  type DecisionCardHashedFields,
} from '../schema';

function baseInput(overrides: Partial<DecisionCardInput> = {}): DecisionCardInput {
  return {
    source: 'review',
    subject: { kind: 'pr', ref: '#123', url: 'https://github.com/ima-jin/imajin-ai/pull/123' },
    question: 'Merge now or wait for CI?',
    options: [
      { letter: 'a', label: 'Merge now', consequence: 'Ships with a flaky CI run unresolved.' },
      { letter: 'b', label: 'Wait for CI', consequence: 'Delays the release by an unknown amount.' },
    ],
    rec: { letter: 'b', why: 'CI flake rate is high enough to be worth the wait.' },
    evidence: {
      authority: { canActWithoutHuman: false, rule: 'merges require an explicit human ruling' },
    },
    ...overrides,
  };
}

describe('validateDecisionCardInput', () => {
  it('accepts a minimal valid input', () => {
    const result = validateDecisionCardInput(baseInput() as unknown as Record<string, unknown>);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid 'source'", () => {
    const result = validateDecisionCardInput(baseInput({ source: 'not-a-source' as never }) as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/source/);
  });

  it("rejects an invalid 'priority'", () => {
    const result = validateDecisionCardInput(baseInput({ priority: 'p9' as never }) as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/priority/);
  });

  it.each(['pr', 'issue', 'run', 'release', 'config'] as const)("accepts subject.kind '%s'", (kind) => {
    const result = validateDecisionCardInput(
      baseInput({ subject: { kind, ref: '#1', url: 'https://example.com/1' } }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a missing subject', () => {
    const input = baseInput() as unknown as Record<string, unknown>;
    delete input.subject;
    expect(validateDecisionCardInput(input).ok).toBe(false);
  });

  it('rejects an invalid subject.kind', () => {
    const result = validateDecisionCardInput(
      baseInput({ subject: { kind: 'bogus' as never, ref: '#1', url: 'https://example.com/1' } }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subject\.kind/);
  });

  it('rejects an empty question', () => {
    const result = validateDecisionCardInput(baseInput({ question: '' }) as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/question/);
  });

  it('rejects fewer than two options', () => {
    const result = validateDecisionCardInput(
      baseInput({ options: [{ letter: 'a', label: 'Only option', consequence: 'x' }] }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/options/);
  });

  it('rejects duplicate option letters', () => {
    const result = validateDecisionCardInput(
      baseInput({
        options: [
          { letter: 'a', label: 'One', consequence: 'x' },
          { letter: 'a', label: 'Two', consequence: 'y' },
        ],
      }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicate/);
  });

  it("rejects a rec.letter that doesn't match any option", () => {
    const result = validateDecisionCardInput(baseInput({ rec: { letter: 'z', why: 'x' } }) as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rec\.letter/);
  });

  it('rejects a missing evidence.authority', () => {
    const input = baseInput() as unknown as Record<string, unknown>;
    (input.evidence as Record<string, unknown>).authority = undefined;
    expect(validateDecisionCardInput(input).ok).toBe(false);
  });

  it('rejects evidence.authority.canActWithoutHuman not being a boolean', () => {
    const result = validateDecisionCardInput(
      baseInput({ evidence: { authority: { canActWithoutHuman: 'no' as never, rule: 'x' } } }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/canActWithoutHuman/);
  });

  it('accepts evidence with no optional keys beyond authority', () => {
    const result = validateDecisionCardInput(
      baseInput({ evidence: { authority: { canActWithoutHuman: true, rule: 'x' } } }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid evidence.review.verdict", () => {
    const result = validateDecisionCardInput(
      baseInput({
        evidence: {
          authority: { canActWithoutHuman: false, rule: 'x' },
          review: { verdict: 'MAYBE' as never, model: 'x', sessionId: 'x', blocking: [], nonBlocking: [], commentUrl: 'https://x' },
        },
      }) as unknown as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verdict/);
  });
});

describe('createDecisionCard', () => {
  it('assigns id/createdAt/contentHash and returns ok for valid input', () => {
    const result = createDecisionCard(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.card.id).toMatch(/^dcard_/);
    expect(result.card.createdAt).toBeTruthy();
    expect(result.card.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses caller-supplied id/createdAt instead of generating them', () => {
    const result = createDecisionCard(baseInput({ id: 'dcard_fixed', createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.card.id).toBe('dcard_fixed');
    expect(result.card.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('propagates a validation failure instead of building a card', () => {
    const result = createDecisionCard(baseInput({ question: '' }));
    expect(result.ok).toBe(false);
  });

  it('never sets ruling — only the countersign path does', () => {
    const result = createDecisionCard(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.card.ruling).toBeUndefined();
  });
});

describe('computeDecisionCardContentHash — stability across re-renders', () => {
  const FIXED_FIELDS: DecisionCardHashedFields = {
    id: 'dcard_fixed',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'review',
    subject: { kind: 'pr', ref: '#123', url: 'https://example.com/pr/123' },
    question: 'Merge now?',
    options: [
      { letter: 'a', label: 'Merge', consequence: 'Ships now.' },
      { letter: 'b', label: 'Wait', consequence: 'Delays.' },
    ],
    rec: { letter: 'a', why: 'CI is green.' },
    evidence: {
      authority: { canActWithoutHuman: false, rule: 'x' },
      ci: { conclusion: 'success', checks: [{ name: 'build', conclusion: 'success', url: 'https://x' }] },
    },
  };

  it('is deterministic for the exact same fields', () => {
    expect(computeDecisionCardContentHash(FIXED_FIELDS)).toBe(computeDecisionCardContentHash(FIXED_FIELDS));
  });

  it('is stable when the object is rebuilt with keys in a different insertion order', () => {
    const reordered: DecisionCardHashedFields = {
      evidence: FIXED_FIELDS.evidence,
      rec: FIXED_FIELDS.rec,
      options: FIXED_FIELDS.options,
      question: FIXED_FIELDS.question,
      subject: FIXED_FIELDS.subject,
      source: FIXED_FIELDS.source,
      createdAt: FIXED_FIELDS.createdAt,
      id: FIXED_FIELDS.id,
    };
    expect(computeDecisionCardContentHash(reordered)).toBe(computeDecisionCardContentHash(FIXED_FIELDS));
  });

  it('is stable across a JSON round-trip (simulating re-hydration after persistence/transport)', () => {
    const roundTripped = JSON.parse(JSON.stringify(FIXED_FIELDS)) as DecisionCardHashedFields;
    expect(computeDecisionCardContentHash(roundTripped)).toBe(computeDecisionCardContentHash(FIXED_FIELDS));
  });

  it('treats an explicit undefined optional field the same as an omitted one', () => {
    const withExplicitUndefined: DecisionCardHashedFields = { ...FIXED_FIELDS, correlationId: undefined };
    expect(computeDecisionCardContentHash(withExplicitUndefined)).toBe(computeDecisionCardContentHash(FIXED_FIELDS));
  });

  it('changes when a hashed field changes', () => {
    const changed: DecisionCardHashedFields = { ...FIXED_FIELDS, question: 'A different question?' };
    expect(computeDecisionCardContentHash(changed)).not.toBe(computeDecisionCardContentHash(FIXED_FIELDS));
  });

  it('does NOT cover `ruling` — createDecisionCard never includes it in the hashed fields', () => {
    const result = createDecisionCard(baseInput({ id: 'dcard_fixed', createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Recomputing the hash straight from the card's own hashed fields (a
    // superset of FIXED_FIELDS's shape, minus contentHash/ruling) must
    // equal the hash createDecisionCard itself produced.
    const { contentHash, ruling, ...hashedFields } = result.card;
    void ruling;
    expect(computeDecisionCardContentHash(hashedFields)).toBe(contentHash);
  });
});
