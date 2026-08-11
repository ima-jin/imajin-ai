import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGroupBy, mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const mockGroupBy = vi.fn();
  const mockWhere = vi.fn(() => ({ groupBy: mockGroupBy }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return { mockGroupBy, mockWhere, mockFrom, mockSelect };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  attestations: {
    type: 'attestations.type',
    issuerDid: 'attestations.issuerDid',
    subjectDid: 'attestations.subjectDid',
    contextType: 'attestations.contextType',
    revokedAt: 'attestations.revokedAt',
    issuedAt: 'attestations.issuedAt',
  },
  githubActionProposals: {
    ownerDid: 'githubActionProposals.ownerDid',
    agentDid: 'githubActionProposals.agentDid',
    scope: 'githubActionProposals.scope',
    tool: 'githubActionProposals.tool',
    status: 'githubActionProposals.status',
    createdAt: 'githubActionProposals.createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  or: (...args: unknown[]) => ({ or: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

import {
  buildConnectorTelemetryRollup,
  readConnectorTelemetry,
  type AttestationCountRow,
  type GithubActionCountRow,
} from '../connector-telemetry';
import { CONNECTOR_REGISTRY, type ConnectorEntry } from '../connector-registry';

const GITHUB_ENTRY: ConnectorEntry = CONNECTOR_REGISTRY.find((c) => c.id === 'github')!;
const DISCORD_ENTRY: ConnectorEntry = CONNECTOR_REGISTRY.find((c) => c.id === 'discord')!;

const OWNER = 'did:imajin:owner';
const CONSUMER = 'did:imajin:consumer';

describe('buildConnectorTelemetryRollup (#1799)', () => {
  it('returns an empty rollup with null timestamps when nothing was signed', () => {
    const rollup = buildConnectorTelemetryRollup(GITHUB_ENTRY, OWNER, null, [], []);

    expect(rollup).toEqual({
      connectorId: 'github',
      ownerDid: OWNER,
      consumerDid: null,
      scopes: GITHUB_ENTRY.scopes.map((s) => s.name),
      totalCount: 0,
      byKind: [],
      firstSeenAt: null,
      lastSeenAt: null,
    });
  });

  it('combines attestation and github-action rows into one byKind list with a summed total', () => {
    const attestationRows: AttestationCountRow[] = [
      { type: 'contributor.issue.closed', count: 3, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-05T00:00:00.000Z' },
    ];
    const githubActionRows: GithubActionCountRow[] = [
      { tool: 'github_create_issue', count: 5, firstSeenAt: '2026-01-02T00:00:00.000Z', lastSeenAt: '2026-01-10T00:00:00.000Z' },
    ];

    const rollup = buildConnectorTelemetryRollup(GITHUB_ENTRY, OWNER, CONSUMER, attestationRows, githubActionRows);

    expect(rollup.totalCount).toBe(8);
    expect(rollup.byKind).toEqual([
      { source: 'attestation', kind: 'contributor.issue.closed', count: 3 },
      { source: 'github_action', kind: 'github_create_issue', count: 5 },
    ]);
    // Earliest of both sources' firstSeenAt, latest of both sources' lastSeenAt.
    expect(rollup.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rollup.lastSeenAt).toBe('2026-01-10T00:00:00.000Z');
    expect(rollup.consumerDid).toBe(CONSUMER);
  });

  it('ignores unparseable timestamps rather than throwing', () => {
    const attestationRows: AttestationCountRow[] = [
      { type: 'vouch', count: 1, firstSeenAt: 'not-a-date', lastSeenAt: 'not-a-date' },
    ];

    const rollup = buildConnectorTelemetryRollup(GITHUB_ENTRY, OWNER, null, attestationRows, []);

    expect(rollup.totalCount).toBe(1);
    expect(rollup.firstSeenAt).toBeNull();
    expect(rollup.lastSeenAt).toBeNull();
  });
});

describe('readConnectorTelemetry (#1799)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockFrom.mockImplementation(() => ({ where: mockWhere }));
    mockWhere.mockImplementation(() => ({ groupBy: mockGroupBy }));
    mockGroupBy.mockResolvedValue([]);
  });

  it('queries only auth.attestations for a connector with no signed action ledger', async () => {
    mockGroupBy.mockResolvedValueOnce([
      { type: 'discord.post', count: 2, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z' },
    ]);

    const rollup = await readConnectorTelemetry(DISCORD_ENTRY, OWNER, null);

    // Exactly one grouped query — no github.action_proposals read for Discord.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockGroupBy).toHaveBeenCalledWith('attestations.type');
    expect(rollup.byKind).toEqual([{ source: 'attestation', kind: 'discord.post', count: 2 }]);
  });

  it('queries both auth.attestations and github.action_proposals for github', async () => {
    mockGroupBy
      .mockResolvedValueOnce([]) // attestations
      .mockResolvedValueOnce([
        { tool: 'github_create_issue', count: 4, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-03T00:00:00.000Z' },
      ]); // github action proposals

    const rollup = await readConnectorTelemetry(GITHUB_ENTRY, OWNER, null);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(rollup.byKind).toEqual([{ source: 'github_action', kind: 'github_create_issue', count: 4 }]);
  });

  it("scopes the github action query to the connector's registered scopes and status=done", async () => {
    await readConnectorTelemetry(GITHUB_ENTRY, OWNER, null);

    // Second where() call is the github.action_proposals query.
    const [, githubWhereArgs] = mockWhere.mock.calls;
    const [andArg] = githubWhereArgs as [{ and: unknown[] }];
    expect(andArg.and).toEqual(
      expect.arrayContaining([
        { eq: ['githubActionProposals.ownerDid', OWNER] },
        { eq: ['githubActionProposals.status', 'done'] },
        { inArray: ['githubActionProposals.scope', GITHUB_ENTRY.scopes.map((s) => s.name)] },
      ]),
    );
  });

  it('treats consumerDid === ownerDid as "the owner acted directly" (agentDid IS NULL)', async () => {
    await readConnectorTelemetry(GITHUB_ENTRY, OWNER, OWNER);

    const [, githubWhereArgs] = mockWhere.mock.calls;
    const [andArg] = githubWhereArgs as [{ and: unknown[] }];
    expect(andArg.and).toEqual(
      expect.arrayContaining([{ isNull: ['githubActionProposals.agentDid'] }]),
    );
  });

  it('filters github actions to a specific delegate when consumerDid names one', async () => {
    await readConnectorTelemetry(GITHUB_ENTRY, OWNER, CONSUMER);

    const [, githubWhereArgs] = mockWhere.mock.calls;
    const [andArg] = githubWhereArgs as [{ and: unknown[] }];
    expect(andArg.and).toEqual(
      expect.arrayContaining([{ eq: ['githubActionProposals.agentDid', CONSUMER] }]),
    );
  });

  it('builds an order-independent DID-pair condition for attestations when consumerDid is given', async () => {
    await readConnectorTelemetry(GITHUB_ENTRY, OWNER, CONSUMER);

    const [attestationWhereArgs] = mockWhere.mock.calls;
    const [andArg] = attestationWhereArgs as [{ and: unknown[] }];
    const pairCondition = andArg.and[andArg.and.length - 1] as { or: unknown[] };
    expect(pairCondition.or).toEqual([
      { and: [{ eq: ['attestations.issuerDid', OWNER] }, { eq: ['attestations.subjectDid', CONSUMER] }] },
      { and: [{ eq: ['attestations.issuerDid', CONSUMER] }, { eq: ['attestations.subjectDid', OWNER] }] },
    ]);
  });

  it('propagates database errors so the route can fail closed', async () => {
    mockGroupBy.mockRejectedValueOnce(new Error('connection reset'));

    await expect(readConnectorTelemetry(DISCORD_ENTRY, OWNER, null)).rejects.toThrow('connection reset');
  });
});
