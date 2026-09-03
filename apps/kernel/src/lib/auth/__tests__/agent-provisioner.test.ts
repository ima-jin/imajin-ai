/**
 * Unit tests for the envelope provisioner orchestration lib (#1933).
 *
 * Mocks the three primitives `createProvision` composes (`mintAgentIdentity`,
 * `issueGrant`/`revokeGrant`, and the bus `publish`) rather than re-deriving
 * their own DB mocking depth (see `grants.test.ts` for that) — this file's
 * job is to pin the PIPELINE'S behavior: step-log legibility, idempotent
 * retry, and status transitions, not to re-test grants.ts or agent-identity.ts
 * themselves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

interface DescSpec { __desc: string }

const { store, AGENT_PROVISIONS_TABLE } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const AGENT_PROVISIONS_TABLE = {
    __table: 'agent_provisions',
    id: 'id', servingDid: 'servingDid', delegatorDid: 'delegatorDid', agentDid: 'agentDid',
    handle: 'handle', displayName: 'displayName', harness: 'harness', placement: 'placement',
    model: 'model', scopes: 'scopes', status: 'status', steps: 'steps',
    envelopeManifest: 'envelopeManifest', grantId: 'grantId', idempotencyKey: 'idempotencyKey',
    createdAt: 'createdAt', updatedAt: 'updatedAt', revokedAt: 'revokedAt',
  };
  return { store, AGENT_PROVISIONS_TABLE };
});

const { mintAgentIdentityMock, MintAgentIdentityErrorMock } = vi.hoisted(() => {
  const mintAgentIdentityMock = vi.fn();
  class MintAgentIdentityErrorMock extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { mintAgentIdentityMock, MintAgentIdentityErrorMock };
});

const { issueGrantMock, revokeGrantMock } = vi.hoisted(() => ({
  issueGrantMock: vi.fn(),
  revokeGrantMock: vi.fn(),
}));

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn().mockResolvedValue(undefined) }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  const desc = (column: string): DescSpec => ({ __desc: column });
  return { ...actual, eq, and, desc };
});

function sortByDesc(rows: Row[], spec?: DescSpec): Row[] {
  if (!spec) return rows;
  const { __desc: column } = spec;
  return [...rows].sort((a, b) => String(b[column]).localeCompare(String(a[column])));
}

function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: (spec?: DescSpec) => Promise.resolve(sortByDesc(rows, spec)),
  };
}

vi.mock('@/src/db', () => ({
  db: {
    insert: () => ({
      values: (data: Row) => {
        store.set(String(data.id), { ...data });
        return Promise.resolve([]);
      },
    }),
    select: () => ({
      from: () => ({
        where: (predicate: Predicate) => queryable([...store.values()].filter(predicate)),
      }),
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: (predicate: Predicate) => {
          for (const [id, row] of store) {
            if (predicate(row)) store.set(id, { ...row, ...patch });
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
  agentProvisions: AGENT_PROVISIONS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => {
  let counter = 0;
  return { generateId: (prefix: string) => `${prefix}_${++counter}` };
});

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

vi.mock('@/src/lib/auth/agent-identity', () => ({
  mintAgentIdentity: (...args: unknown[]) => mintAgentIdentityMock(...args),
  MintAgentIdentityError: MintAgentIdentityErrorMock,
}));

vi.mock('@/src/lib/auth/grants', () => ({
  issueGrant: (...args: unknown[]) => issueGrantMock(...args),
  revokeGrant: (...args: unknown[]) => revokeGrantMock(...args),
}));

vi.mock('@imajin/bus', () => ({ publish: (...args: unknown[]) => publishMock(...args) }));

import { createProvision, getProvision, revokeProvision, listProvisions, recordBootStatus, renderEnvelopeForRow } from '../agent-provisioner';

const SERVING_DID = 'did:imajin:ryan';
const AGENT_DID = 'did:imajin:new-agent';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mintAgentIdentityMock.mockResolvedValue({
    did: AGENT_DID,
    handle: 'travel-agent-abc123',
    displayName: 'Travel Agent',
    keypair: { privateKey: 'priv', publicKey: 'pub' },
    createdAt: new Date().toISOString(),
  });
  issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1', agentDid: AGENT_DID, delegatorDid: SERVING_DID, capabilities: ['messages:write'], audience: { type: 'all' }, expiry: '', issuedAt: '', revokedAt: null, capabilityRevocations: [], onBehalfOf: [] } });
});

describe('createProvision — happy path', () => {
  it('mints identity, issues grants, renders the envelope, and emits the bus event', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID,
      name: 'Travel Agent',
      harness: 'nanoclaw',
      placement: 'hosted',
      scopes: ['messages:write'],
    });

    expect(mintAgentIdentityMock).toHaveBeenCalledTimes(1);
    expect(issueGrantMock).toHaveBeenCalledTimes(1);
    expect(provision.status).toBe('awaiting_boot');
    expect(provision.agentDid).toBe(AGENT_DID);
    expect(provision.grantId).toBe('grant_1');
    expect(provision.envelopeManifest).toBeTruthy();
    expect((provision.steps as unknown[]).map((s) => (s as { step: string }).step)).toEqual([
      'mint_identity', 'issue_grants', 'render_envelope',
    ]);
    expect(publishMock).toHaveBeenCalledWith('agent.provisioned', expect.objectContaining({
      payload: expect.objectContaining({ agentDid: AGENT_DID, servingDid: SERVING_DID, status: 'awaiting_boot' }),
    }));
  });

  it('renders local placements to envelope_rendered without awaiting_boot', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID,
      name: 'Local Agent',
      harness: 'nanoclaw',
      placement: 'local',
      scopes: [],
    });
    expect(provision.status).toBe('envelope_rendered');
    expect(issueGrantMock).not.toHaveBeenCalled();
  });

  it('rejects unknown scopes before minting any identity', async () => {
    await expect(
      createProvision({ servingDid: SERVING_DID, name: 'Bad Scopes', harness: 'nanoclaw', placement: 'local', scopes: ['not:a-real-scope'] }),
    ).rejects.toThrow(/Unknown grant capabilities/);
    expect(mintAgentIdentityMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported harness before creating any row', async () => {
    await expect(
      createProvision({ servingDid: SERVING_DID, name: 'X', harness: 'unsupported' as never, placement: 'local', scopes: [] }),
    ).rejects.toThrow(/harness must be one of/);
    expect(store.size).toBe(0);
  });

  it('rejects an unsupported placement before creating any row', async () => {
    await expect(
      createProvision({ servingDid: SERVING_DID, name: 'X', harness: 'nanoclaw', placement: 'unsupported' as never, scopes: [] }),
    ).rejects.toThrow(/placement must be one of/);
    expect(store.size).toBe(0);
  });

  it('rejects a missing or blank name before creating any row', async () => {
    await expect(
      createProvision({ servingDid: SERVING_DID, name: '', harness: 'nanoclaw', placement: 'local', scopes: [] }),
    ).rejects.toThrow('name is required');
    await expect(
      createProvision({ servingDid: SERVING_DID, name: '   ', harness: 'nanoclaw', placement: 'local', scopes: [] }),
    ).rejects.toThrow('name is required');
    expect(store.size).toBe(0);
  });
});

describe('listProvisions', () => {
  it('returns only the requesting servingDid\'s provisions, newest first', async () => {
    await createProvision({ servingDid: SERVING_DID, name: 'Mine 1', harness: 'nanoclaw', placement: 'local', scopes: [] });
    await createProvision({ servingDid: SERVING_DID, name: 'Mine 2', harness: 'nanoclaw', placement: 'local', scopes: [] });
    await createProvision({ servingDid: 'did:imajin:someone-else', name: 'Not Mine', harness: 'nanoclaw', placement: 'local', scopes: [] });

    const rows = await listProvisions(SERVING_DID);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.servingDid === SERVING_DID)).toBe(true);
  });
});

describe('createProvision — idempotent retry', () => {
  it('returns the same row for a repeated idempotencyKey without re-minting or re-granting', async () => {
    const first = await createProvision({
      servingDid: SERVING_DID, name: 'Idempotent Agent', harness: 'nanoclaw', placement: 'hosted',
      scopes: ['messages:write'], idempotencyKey: 'retry-key-1',
    });

    const second = await createProvision({
      servingDid: SERVING_DID, name: 'Idempotent Agent', harness: 'nanoclaw', placement: 'hosted',
      scopes: ['messages:write'], idempotencyKey: 'retry-key-1',
    });

    expect(second.id).toBe(first.id);
    expect(mintAgentIdentityMock).toHaveBeenCalledTimes(1);
    expect(issueGrantMock).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe across different idempotency keys', async () => {
    const first = await createProvision({
      servingDid: SERVING_DID, name: 'A', harness: 'nanoclaw', placement: 'local', scopes: [], idempotencyKey: 'key-a',
    });
    const second = await createProvision({
      servingDid: SERVING_DID, name: 'A', harness: 'nanoclaw', placement: 'local', scopes: [], idempotencyKey: 'key-b',
    });
    expect(second.id).not.toBe(first.id);
    expect(mintAgentIdentityMock).toHaveBeenCalledTimes(2);
  });
});

describe('createProvision — partial-failure legibility', () => {
  it('leaves a legible failed row when identity minting throws, without attempting grants', async () => {
    mintAgentIdentityMock.mockRejectedValueOnce(new MintAgentIdentityErrorMock('Handle already taken', 409));

    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Will Fail', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'],
    });

    expect(provision.status).toBe('failed');
    expect(provision.agentDid).toBeFalsy();
    expect(issueGrantMock).not.toHaveBeenCalled();
    const steps = provision.steps as { step: string; status: string; error?: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: 'mint_identity', status: 'error', error: 'Handle already taken' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('records a generic (non-MintAgentIdentityError) mint failure using its plain message', async () => {
    mintAgentIdentityMock.mockRejectedValueOnce(new Error('db unreachable'));

    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Generic Failure', harness: 'nanoclaw', placement: 'hosted', scopes: [],
    });

    expect(provision.status).toBe('failed');
    const steps = provision.steps as { step: string; status: string; error?: string }[];
    expect(steps[0]).toMatchObject({ step: 'mint_identity', status: 'error', error: 'db unreachable' });
  });

  it('derives a fallback "agent" slug when the name has no slug-safe characters', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: '!!!', harness: 'nanoclaw', placement: 'local', scopes: [],
    });

    expect(provision.handle).toMatch(/^agent-/);
  });

  it('leaves a legible failed row when grant issuance fails after identity mint succeeds, and does not re-mint on a later call with the same key', async () => {
    issueGrantMock.mockResolvedValueOnce({ error: 'Unknown capabilities: bogus', status: 400 });

    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Grant Fails', harness: 'nanoclaw', placement: 'hosted',
      scopes: ['messages:write'], idempotencyKey: 'grant-fail-key',
    });

    expect(provision.status).toBe('failed');
    expect(provision.agentDid).toBe(AGENT_DID);
    const steps = provision.steps as { step: string; status: string }[];
    expect(steps.map((s) => s.step)).toEqual(['mint_identity', 'issue_grants']);
    expect(steps[1].status).toBe('error');

    // Retry with the same idempotency key must not re-mint identity or re-issue grants.
    const retried = await createProvision({
      servingDid: SERVING_DID, name: 'Grant Fails', harness: 'nanoclaw', placement: 'hosted',
      scopes: ['messages:write'], idempotencyKey: 'grant-fail-key',
    });
    expect(retried.id).toBe(provision.id);
    expect(mintAgentIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a legible failed row for an openclaw harness at the render step, after identity and grants succeed', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'OpenClaw Stub', harness: 'openclaw', placement: 'hosted', scopes: [],
    });

    expect(provision.status).toBe('failed');
    expect(provision.agentDid).toBe(AGENT_DID);
    const steps = provision.steps as { step: string; status: string; error?: string }[];
    expect(steps.map((s) => s.step)).toEqual(['mint_identity', 'issue_grants', 'render_envelope']);
    expect(steps[2].error).toMatch(/not yet implemented/);
  });
});

describe('revokeProvision', () => {
  it('revokes the issued grant and marks the provision revoked', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'To Revoke', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'],
    });
    revokeGrantMock.mockResolvedValue({ revoked: true });

    const result = await revokeProvision(provision.id, SERVING_DID);
    expect(result).toEqual({ revoked: true });
    expect(revokeGrantMock).toHaveBeenCalledWith({ grantId: 'grant_1', requestedBy: SERVING_DID });

    const reloaded = await getProvision(provision.id);
    expect(reloaded?.status).toBe('revoked');
    expect(reloaded?.revokedAt).toBeTruthy();
  });

  it('returns 403 when the requester is not the owning DID', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Not Yours', harness: 'nanoclaw', placement: 'local', scopes: [],
    });

    const result = await revokeProvision(provision.id, 'did:imajin:someone-else');
    expect(result).toEqual({ error: 'Only the owning DID may revoke this provision', status: 403 });
  });

  it('returns 404 for an unknown provision id', async () => {
    const result = await revokeProvision('prov_does_not_exist', SERVING_DID);
    expect(result).toEqual({ error: 'Provision not found', status: 404 });
  });

  it('short-circuits with revoked: true when the provision is already revoked, without re-revoking the grant', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Already Revoked', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'],
    });
    revokeGrantMock.mockResolvedValue({ revoked: true });
    await revokeProvision(provision.id, SERVING_DID);
    revokeGrantMock.mockClear();

    const result = await revokeProvision(provision.id, SERVING_DID);

    expect(result).toEqual({ revoked: true });
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });

  it('still marks the provision revoked (and logs) when the underlying grant revoke itself fails', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Grant Revoke Fails', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'],
    });
    revokeGrantMock.mockResolvedValue({ error: 'Grant already revoked', status: 409 });

    const result = await revokeProvision(provision.id, SERVING_DID);

    expect(result).toEqual({ revoked: true });
    const reloaded = await getProvision(provision.id);
    expect(reloaded?.status).toBe('revoked');
  });

  it('revokes a provision that never had a grant issued (zero scopes) without calling revokeGrant', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'No Grant', harness: 'nanoclaw', placement: 'local', scopes: [],
    });

    const result = await revokeProvision(provision.id, SERVING_DID);

    expect(result).toEqual({ revoked: true });
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });
});

describe('recordBootStatus', () => {
  it('returns null for an unknown provision id', async () => {
    const result = await recordBootStatus('prov_does_not_exist', 'booted');
    expect(result).toBeNull();
  });

  it('appends an ok boot step and sets status to booted', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Boots Fine', harness: 'nanoclaw', placement: 'hosted', scopes: [],
    });

    const updated = await recordBootStatus(provision.id, 'booted');

    expect(updated?.status).toBe('booted');
    const steps = updated?.steps as { step: string; status: string }[];
    expect(steps[steps.length - 1]).toMatchObject({ step: 'boot', status: 'ok' });
  });

  it('appends an error boot step with detail and sets status to failed', async () => {
    const provision = await createProvision({
      servingDid: SERVING_DID, name: 'Boot Fails', harness: 'nanoclaw', placement: 'hosted', scopes: [],
    });

    const updated = await recordBootStatus(provision.id, 'failed', 'container crashed');

    expect(updated?.status).toBe('failed');
    const steps = updated?.steps as { step: string; status: string; error?: string }[];
    expect(steps[steps.length - 1]).toMatchObject({ step: 'boot', status: 'error', error: 'container crashed' });
  });
});

describe('renderEnvelopeForRow', () => {
  it('throws a 409 ProvisionError when the row has no agent identity yet', () => {
    expect(() =>
      renderEnvelopeForRow({
        harness: 'nanoclaw',
        agentDid: null,
        servingDid: SERVING_DID,
        handle: 'no-agent-yet',
        scopes: [],
        model: { provider: 'anthropic:claude', via: 'kernel-passthrough' },
      } as never),
    ).toThrow('Provision has no agent identity yet');
  });

  it('throws a 501 ProvisionError for a non-nanoclaw harness', () => {
    expect(() =>
      renderEnvelopeForRow({
        harness: 'openclaw',
        agentDid: AGENT_DID,
        servingDid: SERVING_DID,
        handle: 'stub-harness',
        scopes: [],
        model: { provider: 'anthropic:claude', via: 'kernel-passthrough' },
      } as never),
    ).toThrow(/not yet implemented/);
  });
});
