/**
 * Unit tests for the retrace walk orchestration (#1962).
 *
 * Exercises `walkRetrace` against a fake in-memory `RetraceRepository` so
 * the cycle guard, depth guard, tombstone insertion, and terminal
 * reporting are pinned without a database. Per-kind parent-link resolution
 * rules live in `repository.test.ts`; auth composition lives in
 * `authorize.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { walkRetrace, RetraceNotFoundError, RetraceForbiddenStartError } from '../walk';
import type { ArtifactRef, HopRecord, RetraceRepository } from '../types';

function ref(kind: ArtifactRef['kind'], id: string): ArtifactRef {
  return { kind, id };
}

function hop(overrides: Partial<HopRecord> & Pick<HopRecord, 'ref'>): HopRecord {
  return {
    actorDid: 'did:imajin:actor',
    onBehalfOf: null,
    grant: null,
    route: 'attestation.created',
    timestamp: '2026-01-01T00:00:00.000Z',
    signature: 'verified',
    audience: { subjectDid: 'did:imajin:subject', actorDid: 'did:imajin:actor', delegatorDid: null, disclosureScope: 'parties' },
    parent: null,
    terminalReason: null,
    ...overrides,
  };
}

/** A fake repository backed by a plain map, with an always-true or per-key readability predicate. */
function fakeRepository(records: HopRecord[], unreadableKeys: ReadonlySet<string> = new Set()): RetraceRepository {
  const byKey = new Map(records.map((r) => [`${r.ref.kind}:${r.ref.id}`, r]));
  return {
    fetch: async (r) => byKey.get(`${r.kind}:${r.id}`) ?? null,
    canRead: async (_viewerDid, audience) => !unreadableKeys.has(audience.subjectDid),
  };
}

const VIEWER = 'did:imajin:viewer';

describe('walkRetrace', () => {
  it('walks a linear chain newest-to-oldest and reports the terminal hop', async () => {
    const a = hop({ ref: ref('attestation', 'att_a'), audience: { subjectDid: 'a', actorDid: 'a', delegatorDid: null, disclosureScope: 'parties' }, parent: ref('attestation', 'att_b') });
    const b = hop({ ref: ref('attestation', 'att_b'), audience: { subjectDid: 'b', actorDid: 'b', delegatorDid: null, disclosureScope: 'parties' }, parent: ref('attestation', 'att_c') });
    const c = hop({ ref: ref('attestation', 'att_c'), audience: { subjectDid: 'c', actorDid: 'c', delegatorDid: null, disclosureScope: 'parties' }, parent: null, terminalReason: 'origin' });
    const repo = fakeRepository([a, b, c]);

    const result = await walkRetrace(ref('attestation', 'att_a'), VIEWER, repo);

    expect(result.hops).toHaveLength(3);
    expect(result.hops.map((h) => ('output' in h ? h.output : null))).toEqual(['att_a', 'att_b', 'att_c']);
    expect(result.terminal).toEqual({ reached: true, ref: ref('attestation', 'att_c'), reason: 'origin' });
    expect(result.truncated).toBe(false);
  });

  it('renders an unauthorized mid-chain hop as an opaque tombstone but keeps walking past it', async () => {
    const a = hop({ ref: ref('attestation', 'att_a'), audience: { subjectDid: 'a', actorDid: 'a', delegatorDid: null, disclosureScope: 'parties' }, parent: ref('attestation', 'att_b') });
    const b = hop({ ref: ref('attestation', 'att_b'), audience: { subjectDid: 'secret-org', actorDid: 'secret-org', delegatorDid: null, disclosureScope: 'parties' }, parent: ref('attestation', 'att_c') });
    const c = hop({ ref: ref('attestation', 'att_c'), audience: { subjectDid: 'c', actorDid: 'c', delegatorDid: null, disclosureScope: 'parties' }, parent: null, terminalReason: 'origin' });
    const repo = fakeRepository([a, b, c], new Set(['secret-org']));

    const result = await walkRetrace(ref('attestation', 'att_a'), VIEWER, repo);

    expect(result.hops).toHaveLength(3);
    expect(result.hops[0]).toMatchObject({ output: 'att_a' });
    expect(result.hops[1]).toMatchObject({ kind: 'tombstone' });
    expect(result.hops[1]).not.toHaveProperty('output');
    expect(result.hops[2]).toMatchObject({ output: 'att_c' });
    expect(result.terminal.reached).toBe(true);
  });

  it('stops and reports truncated on a cycle rather than looping forever', async () => {
    const a = hop({ ref: ref('attestation', 'att_a'), parent: ref('attestation', 'att_b') });
    const b = hop({ ref: ref('attestation', 'att_b'), parent: ref('attestation', 'att_a') });
    const repo = fakeRepository([a, b]);

    const result = await walkRetrace(ref('attestation', 'att_a'), VIEWER, repo);

    expect(result.truncated).toBe(true);
    expect(result.hops).toHaveLength(2);
    expect(result.terminal.reached).toBe(false);
  });

  it('truncates at the configured max depth on a long, non-cyclic chain', async () => {
    const records: HopRecord[] = Array.from({ length: 10 }, (_, i) =>
      hop({ ref: ref('attestation', `att_${i}`), parent: i < 9 ? ref('attestation', `att_${i + 1}`) : null }),
    );
    const repo = fakeRepository(records);

    const result = await walkRetrace(ref('attestation', 'att_0'), VIEWER, repo, 3);

    expect(result.hops).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('terminates with a reason when a parent link points at a missing artifact', async () => {
    const a = hop({ ref: ref('attestation', 'att_a'), parent: ref('attestation', 'att_missing') });
    const repo = fakeRepository([a]);

    const result = await walkRetrace(ref('attestation', 'att_a'), VIEWER, repo);

    expect(result.hops).toHaveLength(1);
    expect(result.terminal.reached).toBe(true);
    expect(result.terminal.ref).toBeNull();
    expect(result.terminal.reason).toMatch(/not found/i);
  });

  it('throws RetraceNotFoundError when the starting artifact does not exist', async () => {
    const repo = fakeRepository([]);
    await expect(walkRetrace(ref('attestation', 'att_missing'), VIEWER, repo)).rejects.toBeInstanceOf(RetraceNotFoundError);
  });

  it('throws RetraceForbiddenStartError when the caller cannot read the starting artifact', async () => {
    const a = hop({ ref: ref('attestation', 'att_a'), audience: { subjectDid: 'secret-org', actorDid: 'secret-org', delegatorDid: null, disclosureScope: 'parties' } });
    const repo = fakeRepository([a], new Set(['secret-org']));
    await expect(walkRetrace(ref('attestation', 'att_a'), VIEWER, repo)).rejects.toBeInstanceOf(RetraceForbiddenStartError);
  });
});
