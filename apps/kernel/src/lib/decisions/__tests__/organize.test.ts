/**
 * Tests for the local decision-card organizer (#2315): deterministic
 * clustering/ranking (the fallback ranker), the mock-provider path, and
 * the 20-card/under-30s/no-network acceptance.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  organizeCards,
  clusterCards,
  formatDeterministicBrief,
  createEnvChatProvider,
  STALE_AGE_MS,
  type OrganizerChatProvider,
} from '../organize';
import { createDecisionCard, type DecisionCard, type DecisionCardInput } from '../schema';

// A real "now" anchor (rather than a fixed past/future date) so tests
// exercising `organizeCards`'s own internal `Date.now()` staleness check
// (which does not take an explicit `now`) stay consistent with the fixed
// `NOW` used by the `clusterCards(cards, NOW)` calls below.
const NOW = Date.now();

function card(overrides: Partial<DecisionCardInput> = {}, ageMs = 0): DecisionCard {
  const built = createDecisionCard({
    id: overrides.id ?? `dcard_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date(NOW - ageMs).toISOString(),
    source: 'automation',
    subject: { kind: 'pr', ref: '#1', url: 'https://example.com/1' },
    question: 'Merge now?',
    options: [
      { letter: 'a', label: 'Merge', consequence: 'x' },
      { letter: 'b', label: 'Wait', consequence: 'y' },
    ],
    rec: { letter: 'a', why: 'x' },
    evidence: { authority: { canActWithoutHuman: false, rule: 'x' } },
    ...overrides,
  });
  if (!built.ok) throw new Error(`invalid fixture card: ${built.error}`);
  return built.card;
}

describe('clusterCards — subject/blocker graph', () => {
  it('groups cards that share the same subject into one cluster', () => {
    const a = card({ id: 'dcard_a', subject: { kind: 'pr', ref: '#100', url: 'https://x/100' } });
    const b = card({ id: 'dcard_b', subject: { kind: 'pr', ref: '#100', url: 'https://x/100' } });
    const other = card({ id: 'dcard_c', subject: { kind: 'pr', ref: '#200', url: 'https://x/200' } });

    const clusters = clusterCards([a, b, other], NOW);

    expect(clusters).toHaveLength(2);
    const withTwo = clusters.find((c) => c.cards.length === 2);
    expect(withTwo).toBeDefined();
    expect(withTwo?.cards.map((entry) => entry.card.id).sort()).toEqual(['dcard_a', 'dcard_b']);
  });

  it('joins two different subjects into one cluster via the blocker graph', () => {
    const issue45 = card({ id: 'dcard_issue', subject: { kind: 'issue', ref: '#45', url: 'https://x/45' } });
    const pr123 = card({
      id: 'dcard_pr',
      subject: { kind: 'pr', ref: '#123', url: 'https://x/123' },
      evidence: {
        authority: { canActWithoutHuman: false, rule: 'x' },
        blockers: { blockedBy: [{ number: 45, state: 'open' }], blocks: [] },
      },
    });
    const unrelated = card({ id: 'dcard_unrelated', subject: { kind: 'pr', ref: '#999', url: 'https://x/999' } });

    const clusters = clusterCards([issue45, pr123, unrelated], NOW);

    expect(clusters).toHaveLength(2);
    const joined = clusters.find((c) => c.cards.length === 2);
    expect(joined?.cards.map((entry) => entry.card.id).sort()).toEqual(['dcard_issue', 'dcard_pr']);
  });

  it('flags a card stale once it crosses STALE_AGE_MS, and not before', () => {
    const fresh = card({ id: 'dcard_fresh' }, STALE_AGE_MS - 1000);
    const stale = card({ id: 'dcard_stale' }, STALE_AGE_MS + 1000);

    const clusters = clusterCards([fresh, stale], NOW);
    const allEntries = clusters.flatMap((c) => c.cards);

    expect(allEntries.find((entry) => entry.card.id === 'dcard_fresh')?.stale).toBe(false);
    expect(allEntries.find((entry) => entry.card.id === 'dcard_stale')?.stale).toBe(true);
  });
});

describe('rank ordering — p-label · blocks-count · age · CI state · authority', () => {
  it('ranks a p0 card above a p2 card regardless of age', () => {
    const p2 = card({ id: 'dcard_p2', priority: 'p2', subject: { kind: 'pr', ref: '#1', url: 'https://x/1' } }, 1000);
    const p0 = card({ id: 'dcard_p0', priority: 'p0', subject: { kind: 'pr', ref: '#2', url: 'https://x/2' } }, 0);

    const clusters = clusterCards([p2, p0], NOW);
    const order = clusters.map((c) => c.cards[0].card.id);

    expect(order).toEqual(['dcard_p0', 'dcard_p2']);
  });

  it('breaks a priority tie by blocks-count (more blocked things ranks first)', () => {
    // Distinct, non-overlapping blocked-issue numbers so the two cards stay
    // in separate clusters — this test is about cross-cluster rank order,
    // not the blocker-graph clustering covered above.
    const fewBlocks = card({
      id: 'dcard_few',
      subject: { kind: 'pr', ref: '#1', url: 'https://x/1' },
      evidence: { authority: { canActWithoutHuman: false, rule: 'x' }, blockers: { blockedBy: [], blocks: [{ number: 901, state: 'open' }] } },
    });
    const manyBlocks = card({
      id: 'dcard_many',
      subject: { kind: 'pr', ref: '#2', url: 'https://x/2' },
      evidence: {
        authority: { canActWithoutHuman: false, rule: 'x' },
        blockers: { blockedBy: [], blocks: [{ number: 902, state: 'open' }, { number: 903, state: 'open' }] },
      },
    });

    const clusters = clusterCards([fewBlocks, manyBlocks], NOW);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.cards[0].card.id)).toEqual(['dcard_many', 'dcard_few']);
  });

  it('breaks a priority+blocks tie by age (older first)', () => {
    const older = card({ id: 'dcard_older', subject: { kind: 'pr', ref: '#1', url: 'https://x/1' } }, 10_000);
    const newer = card({ id: 'dcard_newer', subject: { kind: 'pr', ref: '#2', url: 'https://x/2' } }, 1_000);

    const clusters = clusterCards([newer, older], NOW);
    expect(clusters.map((c) => c.cards[0].card.id)).toEqual(['dcard_older', 'dcard_newer']);
  });

  it('ranks a card that needs a human (authority.canActWithoutHuman=false) above one that does not, all else equal', () => {
    const needsHuman = card({
      id: 'dcard_needs_human',
      subject: { kind: 'pr', ref: '#1', url: 'https://x/1' },
      evidence: { authority: { canActWithoutHuman: false, rule: 'x' } },
    });
    const autoOk = card({
      id: 'dcard_auto_ok',
      subject: { kind: 'pr', ref: '#2', url: 'https://x/2' },
      evidence: { authority: { canActWithoutHuman: true, rule: 'x' } },
    });

    const clusters = clusterCards([autoOk, needsHuman], NOW);
    expect(clusters.map((c) => c.cards[0].card.id)).toEqual(['dcard_needs_human', 'dcard_auto_ok']);
  });
});

describe('formatDeterministicBrief', () => {
  it('renders one line per card, and a message for an empty pile', () => {
    expect(formatDeterministicBrief([])).toBe('No open decision cards.');

    const a = card({ id: 'dcard_a', priority: 'p1', subject: { kind: 'pr', ref: '#1', url: 'https://x/1' } });
    const clusters = clusterCards([a], NOW);
    const brief = formatDeterministicBrief(clusters);

    expect(brief).toContain('[p1]');
    expect(brief).toContain('pr:#1');
    expect(brief.split('\n').filter((line) => line.trim().startsWith('1.'))).toHaveLength(1);
  });
});

describe('organizeCards — no provider (deterministic fallback)', () => {
  it('returns the deterministic brief and usedProvider: false when no provider is given', async () => {
    const a = card({ id: 'dcard_a' });
    const result = await organizeCards([a]);

    expect(result.usedProvider).toBe(false);
    expect(result.brief).toBe(formatDeterministicBrief(result.clusters));
  });

  it('counts stale cards across all clusters', async () => {
    const stale = card({ id: 'dcard_stale', subject: { kind: 'pr', ref: '#1', url: 'https://x/1' } }, STALE_AGE_MS + 1);
    const fresh = card({ id: 'dcard_fresh', subject: { kind: 'pr', ref: '#2', url: 'https://x/2' } }, 0);

    const result = await organizeCards([stale, fresh]);
    expect(result.staleCount).toBe(1);
  });
});

describe('organizeCards — with a mock provider', () => {
  it('gives the provider the deterministic brief and uses its returned text', async () => {
    const a = card({ id: 'dcard_a' });
    const provider: OrganizerChatProvider = { complete: vi.fn().mockResolvedValue('A nicely reworded brief.') };

    const result = await organizeCards([a], provider);

    expect(result.usedProvider).toBe(true);
    expect(result.brief).toBe('A nicely reworded brief.');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const [messages] = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages.some((m: { role: string }) => m.role === 'system')).toBe(true);
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');
    // The provider is only ever given the already-deterministic brief text
    // (cards only, no extra facts) — it must contain the card's own subject.
    expect(userMessage.content).toContain('pr:#1');
  });

  it('falls back to the deterministic brief when the provider throws', async () => {
    const a = card({ id: 'dcard_a' });
    const provider: OrganizerChatProvider = { complete: vi.fn().mockRejectedValue(new Error('unreachable')) };

    const result = await organizeCards([a], provider);

    expect(result.usedProvider).toBe(false);
    expect(result.brief).toBe(formatDeterministicBrief(result.clusters));
  });

  it('falls back to the deterministic brief when the provider returns an empty string', async () => {
    const a = card({ id: 'dcard_a' });
    const provider: OrganizerChatProvider = { complete: vi.fn().mockResolvedValue('   ') };

    const result = await organizeCards([a], provider);

    expect(result.usedProvider).toBe(false);
  });

  it('never reaches the network — organizeCards only ever calls the injected provider.complete', async () => {
    // Guard against a regression that routes the organizer through a real
    // HTTP client: global fetch must never be touched when a plain mock
    // provider is injected, since organizeCards' own logic is cards-only.
    const hasFetch = typeof globalThis.fetch === 'function';
    const fetchSpy = hasFetch ? vi.spyOn(globalThis, 'fetch') : undefined;
    const a = card({ id: 'dcard_a' });
    const provider: OrganizerChatProvider = { complete: vi.fn().mockResolvedValue('brief') };

    await organizeCards([a], provider);

    if (fetchSpy) {
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }
  });
});

describe('organizeCards — 20-card fixture, under 30s, no network', () => {
  it('organizes 20 cards quickly using only the fallback ranker', async () => {
    const cards: DecisionCard[] = Array.from({ length: 20 }, (_, i) =>
      card(
        {
          id: `dcard_${i}`,
          priority: (['p0', 'p1', 'p2', 'p3'] as const)[i % 4],
          subject: { kind: 'pr', ref: `#${1000 + i}`, url: `https://x/${1000 + i}` },
          evidence: {
            authority: { canActWithoutHuman: i % 3 === 0, rule: 'x' },
            ci: { conclusion: i % 2 === 0 ? 'success' : 'failure', checks: [] },
            blockers: { blockedBy: [], blocks: i % 5 === 0 ? [{ number: 1, state: 'open' }] : [] },
          },
        },
        i * 60 * 60 * 1000,
      ),
    );

    const start = Date.now();
    const result = await organizeCards(cards);
    const elapsedMs = Date.now() - start;

    expect(result.clusters.reduce((count, c) => count + c.cards.length, 0)).toBe(20);
    expect(elapsedMs).toBeLessThan(30_000);
  });
});

describe('createEnvChatProvider', () => {
  it('returns undefined when no base URL is configured', () => {
    expect(createEnvChatProvider({})).toBeUndefined();
  });

  it('returns a provider object (without invoking it) when a base URL is configured', () => {
    const provider = createEnvChatProvider({ DECISION_ORGANIZER_BASE_URL: 'http://imajin-ml.internal:11434' });
    expect(provider).toBeDefined();
    expect(typeof provider?.complete).toBe('function');
  });
});
