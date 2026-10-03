import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ groupBy: vi.fn(), where: vi.fn() }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  inArray: (...args: unknown[]) => ({ op: 'inArray', args }),
  isNull: (...args: unknown[]) => ({ op: 'isNull', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', text: strings.join('?'), values }),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  attestations: { type: 'att.type', subjectDid: 'att.subject', revokedAt: 'att.revoked', payload: 'att.payload' },
}));

import { attachEvidenceCounts, countEvidenceByUsageRef } from '../usage-counts';
import { AGENT_DID } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockReturnValue({ groupBy: mocks.groupBy });
});

describe('countEvidenceByUsageRef', () => {
  it('does not query when there are no usage rows', async () => {
    expect(await countEvidenceByUsageRef(AGENT_DID, [])).toEqual(new Map());
    expect(mocks.where).not.toHaveBeenCalled();
  });

  it('counts live evidence rows per usageRef for the subject', async () => {
    mocks.groupBy.mockResolvedValueOnce([
      { usageRef: 'att_u1', count: 3 },
      { usageRef: 'att_u2', count: 1 },
    ]);

    const counts = await countEvidenceByUsageRef(AGENT_DID, ['att_u1', 'att_u2', 'att_u3']);

    expect(counts.get('att_u1')).toBe(3);
    expect(counts.get('att_u2')).toBe(1);
    expect(counts.has('att_u3')).toBe(false);
    const condition = JSON.stringify(mocks.where.mock.calls[0][0]);
    expect(condition).toContain('agent.turn.evidence');
    expect(condition).toContain(AGENT_DID);
    expect(condition).toContain('att.revoked');
  });
});

describe('attachEvidenceCounts', () => {
  it('adds evidenceCount (0 when absent), preserving order and the other fields', () => {
    const rows = [
      { id: 'att_u2', model: 'a' },
      { id: 'att_u3', model: 'b' },
    ];
    const withCounts = attachEvidenceCounts(rows, new Map([['att_u2', 4]]));
    expect(withCounts).toEqual([
      { id: 'att_u2', model: 'a', evidenceCount: 4 },
      { id: 'att_u3', model: 'b', evidenceCount: 0 },
    ]);
    expect(rows[0]).not.toHaveProperty('evidenceCount'); // input not mutated
  });
});
