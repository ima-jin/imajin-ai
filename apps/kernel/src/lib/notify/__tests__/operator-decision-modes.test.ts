/**
 * #2693: which `mode` each approval kind accepts. A mode the card never
 * offered must never be something the operator's signature can bind.
 */
import { describe, it, expect } from 'vitest';
import { EXEC_COMMAND_KIND, EXEC_COMMAND_SOURCE } from '../exec-command-approvals';
import {
  DECISION_CARD_KIND,
  GITHUB_SOURCE,
  GITHUB_TTL_MODES,
  decisionCardOptionLetters,
  validateDecisionMode,
} from '../operator-decision-modes';

const CARD = {
  source: 'decision',
  kind: DECISION_CARD_KIND,
  detail: {
    options: [
      { letter: 'a', label: 'Merge', consequence: '' },
      { letter: 'b', label: 'Hold', consequence: '' },
      { letter: 'c', label: 'Close', consequence: '' },
    ],
  },
};
const GITHUB = { source: GITHUB_SOURCE, kind: 'github:append', detail: null };
const EXEC = { source: EXEC_COMMAND_SOURCE, kind: EXEC_COMMAND_KIND, detail: null };
const GENERIC = { source: 'system-agent', kind: 'system-agent:restart', detail: null };

describe('validateDecisionMode — decision:card', () => {
  it.each(['a', 'b', 'c'])('accepts option letter %s on approve', (letter) => {
    expect(validateDecisionMode(CARD, 'approve', letter)).toEqual({ ok: true });
  });

  it.each(['d', 'A', 'a ', 'merge', 'single', 'allow-once'])("refuses '%s' — not one of the card's letters", (mode) => {
    const result = validateDecisionMode(CARD, 'approve', mode);
    expect(result.ok).toBe(false);
  });

  it('refuses an approve naming no option', () => {
    const result = validateDecisionMode(CARD, 'approve', undefined);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('got no mode') });
  });

  it('refuses every approve when the card offers no usable letters', () => {
    expect(validateDecisionMode({ ...CARD, detail: null }, 'approve', 'a').ok).toBe(false);
    expect(validateDecisionMode({ ...CARD, detail: { options: [] } }, 'approve', 'a').ok).toBe(false);
    expect(validateDecisionMode({ ...CARD, detail: { options: [{ letter: '' }, null, 7, {}] } }, 'approve', 'a').ok).toBe(false);
  });

  it.each(['reject', 'withdrawn'] as const)('%s carries no mode', (decision) => {
    expect(validateDecisionMode(CARD, decision, undefined)).toEqual({ ok: true });
    expect(validateDecisionMode(CARD, decision, 'a').ok).toBe(false);
  });

  it('keys on kind, so a card raised under another source name is still a card', () => {
    expect(validateDecisionMode({ ...CARD, source: 'triage' }, 'approve', 'z').ok).toBe(false);
  });
});

describe('validateDecisionMode — github TTL', () => {
  it.each(GITHUB_TTL_MODES)('accepts %s on approve', (ttl) => {
    expect(validateDecisionMode(GITHUB, 'approve', ttl)).toEqual({ ok: true });
  });

  it('accepts approve with no mode (defaults to single downstream)', () => {
    expect(validateDecisionMode(GITHUB, 'approve', undefined)).toEqual({ ok: true });
  });

  it.each(['forever', '1h', 'allow-once', 'a', '24H'])("refuses unknown TTL '%s'", (mode) => {
    const result = validateDecisionMode(GITHUB, 'approve', mode);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("'single', '5m', '24h'") });
  });

  it.each(['reject', 'withdrawn'] as const)('%s carries no mode, even a valid TTL', (decision) => {
    expect(validateDecisionMode(GITHUB, decision, undefined)).toEqual({ ok: true });
    expect(validateDecisionMode(GITHUB, decision, '5m').ok).toBe(false);
  });
});

describe('validateDecisionMode — exec.command (unchanged #2221 rule)', () => {
  it('approve ⇒ absent | allow-once', () => {
    expect(validateDecisionMode(EXEC, 'approve', undefined)).toEqual({ ok: true });
    expect(validateDecisionMode(EXEC, 'approve', 'allow-once')).toEqual({ ok: true });
    expect(validateDecisionMode(EXEC, 'approve', 'allow-always')).toMatchObject({ ok: false, error: expect.stringContaining('allow-always') });
    expect(validateDecisionMode(EXEC, 'approve', 'deny').ok).toBe(false);
  });

  it('reject ⇒ absent | deny', () => {
    expect(validateDecisionMode(EXEC, 'reject', undefined)).toEqual({ ok: true });
    expect(validateDecisionMode(EXEC, 'reject', 'deny')).toEqual({ ok: true });
    expect(validateDecisionMode(EXEC, 'reject', 'allow-once').ok).toBe(false);
  });
});

describe('validateDecisionMode — every other kind', () => {
  it.each(['approve', 'reject', 'withdrawn'] as const)('%s with no mode is fine', (decision) => {
    expect(validateDecisionMode(GENERIC, decision, undefined)).toEqual({ ok: true });
  });

  it.each(['allow-once', 'allow-always', 'a', '5m', 'x'])("refuses any mode ('%s') — the kind defines none", (mode) => {
    const result = validateDecisionMode(GENERIC, 'approve', mode);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('system-agent:restart') });
  });

  it('applies to the other namespaces too (vault / access / apps)', () => {
    for (const kind of ['vault:mint', 'access:bearer-grant', 'apps:provision']) {
      expect(validateDecisionMode({ source: kind.split(':')[0], kind, detail: null }, 'approve', 'a').ok).toBe(false);
    }
  });
});

describe('decisionCardOptionLetters', () => {
  it('lists the letters, skipping malformed options', () => {
    expect(decisionCardOptionLetters(CARD.detail)).toEqual(['a', 'b', 'c']);
    expect(decisionCardOptionLetters({ options: [{ letter: 'x' }, { letter: 3 }, null] })).toEqual(['x']);
    expect(decisionCardOptionLetters(null)).toEqual([]);
    expect(decisionCardOptionLetters({ options: 'a,b' })).toEqual([]);
  });
});
