/**
 * Tests for the pure DecisionCard view helpers (#2323): the shared `ev:`
 * formatter (fixed key order, `?` for missing), the defensive `detail`
 * parser, the safe-URL gate, and the countersign payload shape.
 */
import { describe, it, expect } from 'vitest';
import {
  DECISION_APPROVAL_KIND,
  DECISION_APPROVAL_SOURCE,
  decisionCardChoicePayload,
  decisionCardEvidenceFields,
  findChosenOption,
  formatDecisionCardEvidenceLine,
  isSafeHttpUrl,
  parseDecisionCardView,
} from '../view';

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dcard_1',
    subject: { kind: 'pr', ref: '#2323', url: 'https://github.com/ima-jin/imajin-ai/pull/2323' },
    question: 'Merge #2323 now?',
    options: [
      { letter: 'a', label: 'Merge now', consequence: 'Ships as-is.' },
      { letter: 'b', label: 'Fix first', consequence: 'Delays one cycle.' },
      { letter: 'c', label: 'Close', consequence: 'Drops the work.' },
    ],
    rec: { letter: 'b', why: 'Cheap fix.' },
    evidence: { authority: { canActWithoutHuman: false, rule: 'human merges' } },
    ...overrides,
  };
}

describe('constants', () => {
  it('keeps the emitter vocabulary: source decision, kind decision:card', () => {
    expect(DECISION_APPROVAL_SOURCE).toBe('decision');
    expect(DECISION_APPROVAL_KIND).toBe('decision:card');
  });
});

describe('decisionCardEvidenceFields', () => {
  it('always yields every key in a fixed order', () => {
    expect(decisionCardEvidenceFields({}).map((f) => f.key)).toEqual([
      'pr',
      'ci',
      'sonar',
      'review',
      'run',
      'blockers',
      'authority',
    ]);
  });

  it('renders ? for every missing evidence kind — missing is data', () => {
    const fields = decisionCardEvidenceFields({ authority: { canActWithoutHuman: true, rule: 'r' } });
    expect(Object.fromEntries(fields.map((f) => [f.key, f.value]))).toEqual({
      pr: '?',
      ci: '?',
      sonar: '?',
      review: '?',
      run: '?',
      blockers: '?',
      authority: 'auto',
    });
  });

  it('renders every key as ? when evidence itself is null or undefined', () => {
    expect(decisionCardEvidenceFields(null).every((f) => f.value === '?')).toBe(true);
    expect(decisionCardEvidenceFields(undefined).every((f) => f.value === '?')).toBe(true);
  });

  it('formats present evidence the way the prose line does', () => {
    const fields = decisionCardEvidenceFields({
      pr: {
        number: 2323,
        title: 't',
        draft: true,
        mergeable: null,
        base: 'main',
        head: 'h',
        headSha: 's',
        filesChanged: 1,
        additions: 1,
        deletions: 0,
        closes: [],
      },
      ci: { conclusion: 'success', checks: [] },
      sonar: { qualityGate: 'OK', newIssues: 0, coverageOnNew: null, url: 'u' },
      review: { verdict: 'NEEDS-DECISION', model: 'm', sessionId: 's', blocking: [], nonBlocking: [], commentUrl: 'u' },
      run: { warpRunId: 'w', status: 'done', durationMs: 1, resumes: 0, branches: [] },
      blockers: { blockedBy: [{ number: 1, state: 'open' }], blocks: [] },
      authority: { canActWithoutHuman: false, rule: 'r' },
    });
    expect(fields.map((f) => `${f.key}=${f.value}`)).toEqual([
      'pr=#2323(draft,unknown)',
      'ci=success',
      'sonar=OK(new:0)',
      'review=NEEDS-DECISION',
      'run=done',
      'blockers=1blocked/0blocks',
      'authority=human',
    ]);
  });

  it('does not throw on malformed blockers (untrusted detail)', () => {
    const malformed = { blockers: {} } as unknown as Parameters<typeof decisionCardEvidenceFields>[0];
    expect(decisionCardEvidenceFields(malformed).find((f) => f.key === 'blockers')?.value).toBe('0blocked/0blocks');
  });
});

describe('formatDecisionCardEvidenceLine', () => {
  it('joins the fields as `ev: k=v …`', () => {
    expect(formatDecisionCardEvidenceLine({})).toBe(
      'ev: pr=? ci=? sonar=? review=? run=? blockers=? authority=?',
    );
  });
});

describe('parseDecisionCardView', () => {
  it('narrows a well-formed card', () => {
    const view = parseDecisionCardView(detail());
    expect(view?.subject.ref).toBe('#2323');
    expect(view?.question).toBe('Merge #2323 now?');
    expect(view?.options.map((o) => o.letter)).toEqual(['a', 'b', 'c']);
    expect(view?.rec).toEqual({ letter: 'b', why: 'Cheap fix.' });
    expect(view?.evidence).not.toBeNull();
  });

  it('keeps the card renderable when evidence is missing entirely', () => {
    const view = parseDecisionCardView(detail({ evidence: undefined }));
    expect(view).not.toBeNull();
    expect(view?.evidence).toBeNull();
  });

  it.each([
    ['null detail', null],
    ['no subject', detail({ subject: undefined })],
    ['subject without ref', detail({ subject: { kind: 'pr', url: 'u' } })],
    ['no question', detail({ question: '' })],
    ['no options', detail({ options: [] })],
    ['option without label', detail({ options: [{ letter: 'a' }] })],
    ['rec naming no option', detail({ rec: { letter: 'z', why: 'w' } })],
    ['no rec', detail({ rec: undefined })],
  ])('returns null for %s', (_name, input) => {
    expect(parseDecisionCardView(input as Record<string, unknown> | null)).toBeNull();
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(isSafeHttpUrl('https://github.com/x')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:3000')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,hi')).toBe(false);
    expect(isSafeHttpUrl('/relative')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
  });
});

describe('decisionCardChoicePayload', () => {
  it('is the existing approve decision with the option letter as mode — nothing else', () => {
    expect(decisionCardChoicePayload('b')).toEqual({ decision: 'approve', mode: 'b' });
    expect(Object.keys(decisionCardChoicePayload('a')).sort()).toEqual(['decision', 'mode']);
  });
});

describe('findChosenOption', () => {
  const options = [
    { letter: 'a', label: 'A', consequence: '' },
    { letter: 'b', label: 'B', consequence: '' },
  ];

  it('finds the option a recorded mode names', () => {
    expect(findChosenOption(options, 'b')?.label).toBe('B');
  });

  it('returns null for a non-option or non-string mode', () => {
    expect(findChosenOption(options, 'z')).toBeNull();
    expect(findChosenOption(options, undefined)).toBeNull();
    expect(findChosenOption(options, 5)).toBeNull();
  });
});
