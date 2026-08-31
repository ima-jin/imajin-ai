/**
 * Unit tests for the external-agent knock lifecycle (#1883).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const {
  identitiesStore,
  knocksStore,
  connectionsStore,
  attestationsStore,
  IDENTITIES_TABLE,
  KNOCKS_TABLE,
  CONNECTIONS_TABLE,
  ATTESTATIONS_TABLE,
} = vi.hoisted(() => {
  const identitiesStore = new Map<string, Row>();
  const knocksStore = new Map<string, Row>();
  const connectionsStore = new Map<string, Row>();
  const attestationsStore = new Map<string, Row>();

  // Column tokens are identity-mapped to their own field name, matching the
  // convention in grants.test.ts.
  const IDENTITIES_TABLE = {
    __table: 'identities',
    id: 'id', scope: 'scope', subtype: 'subtype', publicKey: 'publicKey', handle: 'handle',
    name: 'name', tier: 'tier', metadata: 'metadata', createdAt: 'createdAt', updatedAt: 'updatedAt',
  };
  const KNOCKS_TABLE = {
    __table: 'agent_knocks',
    id: 'id', publicKey: 'publicKey', agentDid: 'agentDid', declaredTarget: 'declaredTarget',
    selfDescription: 'selfDescription', requestedCapabilities: 'requestedCapabilities', externalDid: 'externalDid',
    status: 'status', expiresAt: 'expiresAt', respondedAt: 'respondedAt', createdAt: 'createdAt',
  };
  const CONNECTIONS_TABLE = {
    __table: 'connections',
    didA: 'didA', didB: 'didB', connectedAt: 'connectedAt', disconnectedAt: 'disconnectedAt',
  };
  const ATTESTATIONS_TABLE = {
    __table: 'attestations',
    id: 'id', issuerDid: 'issuerDid', subjectDid: 'subjectDid', type: 'type', contextId: 'contextId',
    contextType: 'contextType', payload: 'payload', signature: 'signature', cid: 'cid',
    attestationStatus: 'attestationStatus', issuedAt: 'issuedAt',
  };

  return { identitiesStore, knocksStore, connectionsStore, attestationsStore, IDENTITIES_TABLE, KNOCKS_TABLE, CONNECTIONS_TABLE, ATTESTATIONS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  switch (table.__table) {
    case 'identities': return identitiesStore;
    case 'agent_knocks': return knocksStore;
    case 'connections': return connectionsStore;
    case 'attestations': return attestationsStore;
    default: throw new Error(`unknown table ${table.__table}`);
  }
}

function keyFor(table: { __table: string }, row: Row): string {
  if (table.__table === 'connections') return `${row.didA as string}::${row.didB as string}`;
  return String(row.id);
}

/** Whether `candidate` matches `row` on every column named in `target` — the onConflictDoUpdate match predicate. */
function matchesConflictTarget(row: Row, candidate: Row, target: string[]): boolean {
  return target.every((col) => candidate[col] === row[col]);
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => {
    const result: Row = {};
    for (const key of Object.keys(projection)) result[key] = row[projection[key]];
    return result;
  });
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const gt = (column: string, value: unknown): Predicate => {
    const b = value instanceof Date ? value.getTime() : (value as number);
    return (row) => {
      const raw = row[column] as Date | number | undefined;
      if (raw === undefined) return false;
      const a = raw instanceof Date ? raw.getTime() : raw;
      return a > b;
    };
  };
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, gt, and };
});

function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    returning: (projection?: Record<string, string>) => Promise.resolve(project(rows, projection)),
  };
}

function insertInto(table: { __table: string }) {
  return {
    values: (data: Row | Row[]) => {
      const store = storeFor(table);
      const rows = Array.isArray(data) ? data : [data];

      const plainInsert = () => {
        for (const row of rows) store.set(keyFor(table, row), { ...row });
        return Promise.resolve(rows);
      };

      return {
        then: (onFulfilled?: (v: Row[]) => unknown, onRejected?: (e: unknown) => unknown) => plainInsert().then(onFulfilled, onRejected),
        catch: (onRejected?: (e: unknown) => unknown) => plainInsert().catch(onRejected),
        finally: (fn: () => void) => plainInsert().finally(fn),
        returning: (projection?: Record<string, string>) => plainInsert().then((r) => project(r, projection)),
        onConflictDoUpdate: ({ target, set }: { target: string[]; set: Row }) => {
          const row = rows[0];
          const existingEntry = [...store.entries()].find(([, existingRow]) => matchesConflictTarget(row, existingRow, target));
          if (existingEntry) {
            store.set(existingEntry[0], { ...existingEntry[1], ...set });
          } else {
            store.set(keyFor(table, row), { ...row });
          }
          return Promise.resolve([]);
        },
      };
    },
  };
}

function updateTable(table: { __table: string }) {
  return {
    set: (patch: Row) => ({
      where: (predicate: Predicate) => {
        const store = storeFor(table);
        const touched: Row[] = [];
        for (const [key, row] of store) {
          if (!predicate(row)) continue;
          const next = { ...row, ...patch };
          store.set(key, next);
          touched.push(next);
        }
        return queryable(touched);
      },
    }),
  };
}

function selectFrom(projection?: Record<string, string>) {
  return {
    from: (table: { __table: string }) => ({
      where: (predicate: Predicate) => queryable(project([...storeFor(table).values()].filter(predicate), projection)),
    }),
  };
}

vi.mock('@/src/db', () => ({
  db: { insert: insertInto, select: selectFrom, update: updateTable },
  identities: IDENTITIES_TABLE,
  agentKnocks: KNOCKS_TABLE,
  connections: CONNECTIONS_TABLE,
  attestations: ATTESTATIONS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => {
  let counter = 0;
  return { generateId: (prefix: string) => `${prefix}_${++counter}` };
});

vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: (publicKeyHex: string) => `did:imajin:${publicKeyHex.slice(0, 12)}`,
}));

const getNodeDidMock = vi.fn();
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: () => getNodeDidMock() }));

const busPublishMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@imajin/bus', () => ({ publish: (...args: unknown[]) => busPublishMock(...args) }));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn().mockResolvedValue('cid_fixed') }));

import {
  submitKnock,
  listPendingKnocksForTarget,
  acceptKnock,
  declineKnock,
  resolveDeclaredTarget,
} from '../knock';

const TARGET_DID = 'did:imajin:ryan';
const TARGET_HANDLE = 'ryan';
const PUBLIC_KEY = 'a'.repeat(64);
const OTHER_PUBLIC_KEY = 'b'.repeat(64);

function seedTargetIdentity() {
  identitiesStore.set(TARGET_DID, { id: TARGET_DID, scope: 'actor', subtype: 'human', publicKey: 'target-pubkey', handle: TARGET_HANDLE, tier: 'established' });
}

beforeEach(() => {
  identitiesStore.clear();
  knocksStore.clear();
  connectionsStore.clear();
  attestationsStore.clear();
  busPublishMock.mockClear();
  getNodeDidMock.mockReset().mockResolvedValue('did:imajin:platform-node');
  delete process.env.AUTH_PRIVATE_KEY;
  seedTargetIdentity();
});

const VALID_INPUT = {
  publicKey: PUBLIC_KEY,
  declaredTarget: TARGET_DID,
  selfDescription: 'A matchmaking agent for professional intros.',
  requestedCapabilities: ['intros:propose', 'messages:write'],
};

describe('resolveDeclaredTarget', () => {
  it('resolves by DID', async () => {
    await expect(resolveDeclaredTarget(TARGET_DID)).resolves.toBe(TARGET_DID);
  });

  it('resolves by handle', async () => {
    await expect(resolveDeclaredTarget(TARGET_HANDLE)).resolves.toBe(TARGET_DID);
  });

  it('returns null for an unresolvable target', async () => {
    await expect(resolveDeclaredTarget('did:imajin:nobody')).resolves.toBeNull();
  });
});

describe('submitKnock — validation and escrow', () => {
  it('rejects a malformed public key', async () => {
    const result = await submitKnock({ ...VALID_INPUT, publicKey: 'not-hex' });
    expect(result).toMatchObject({ status: 400 });
    expect(knocksStore.size).toBe(0);
  });

  it('rejects a declared_target that does not resolve — no stub-minting', async () => {
    const result = await submitKnock({ ...VALID_INPUT, declaredTarget: 'did:imajin:nobody' });
    expect(result).toMatchObject({ status: 404 });
    expect(knocksStore.size).toBe(0);
    expect(identitiesStore.size).toBe(1); // only the seeded target — nothing minted
  });

  it('resolves declared_target by handle', async () => {
    const result = await submitKnock({ ...VALID_INPUT, declaredTarget: TARGET_HANDLE });
    expect('knock' in result).toBe(true);
    if (!('knock' in result)) throw new Error('expected knock');
    expect(result.knock.declaredTarget).toBe(TARGET_DID);
  });

  it('rejects a missing/empty self_description', async () => {
    const result = await submitKnock({ ...VALID_INPUT, selfDescription: '' });
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects malformed requested_capabilities', async () => {
    const result = await submitKnock({ ...VALID_INPUT, requestedCapabilities: ['bad scope'] });
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects a malformed external_did when provided', async () => {
    const result = await submitKnock({ ...VALID_INPUT, externalDid: 'not-a-did' });
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects an identity knocking on itself', async () => {
    // Same public key as the target's derived agentDid would produce a
    // collision — simulate by declaring a target whose DID matches what
    // didFromPublicKey would derive from the knock's own key.
    const selfDid = `did:imajin:${PUBLIC_KEY.slice(0, 12)}`;
    identitiesStore.set(selfDid, { id: selfDid, scope: 'actor', subtype: 'human', publicKey: 'x', handle: 'self' });
    const result = await submitKnock({ ...VALID_INPUT, declaredTarget: selfDid });
    expect(result).toMatchObject({ status: 400 });
  });

  it('escrows the public key without minting any identity (no identity without a human touch)', async () => {
    const result = await submitKnock(VALID_INPUT);
    expect('knock' in result).toBe(true);
    if (!('knock' in result)) throw new Error('expected knock');
    expect(result.knock.status).toBe('pending');
    expect(result.knock.requestedCapabilities).toEqual(VALID_INPUT.requestedCapabilities);
    // Only the pre-seeded target identity exists — no agent identity minted.
    expect(identitiesStore.size).toBe(1);
    expect(identitiesStore.has(result.knock.agentDid)).toBe(false);
  });

  it('is advisory-only: requested_capabilities never appear anywhere but the knock record itself', async () => {
    const result = await submitKnock(VALID_INPUT);
    if (!('knock' in result)) throw new Error('expected knock');
    expect(connectionsStore.size).toBe(0);
    expect(attestationsStore.size).toBe(0);
  });

  it('refreshes an existing pending knock from the same key/target instead of duplicating it (idempotent re-knock)', async () => {
    const first = await submitKnock(VALID_INPUT);
    if (!('knock' in first)) throw new Error('expected knock');

    const second = await submitKnock({ ...VALID_INPUT, selfDescription: 'Updated description.' });
    if (!('knock' in second)) throw new Error('expected knock');

    expect(second.knock.knockId).toBe(first.knock.knockId);
    expect(second.knock.selfDescription).toBe('Updated description.');
    expect(knocksStore.size).toBe(1);
  });

  it('computes the same prospective agentDid for the same public key regardless of target (multi-tenant declaration)', async () => {
    identitiesStore.set('did:imajin:other-target', { id: 'did:imajin:other-target', scope: 'actor', subtype: 'human', publicKey: 'other', handle: 'other' });

    const first = await submitKnock(VALID_INPUT);
    const second = await submitKnock({ ...VALID_INPUT, declaredTarget: 'did:imajin:other-target' });
    if (!('knock' in first) || !('knock' in second)) throw new Error('expected knocks');

    expect(first.knock.agentDid).toBe(second.knock.agentDid);
    expect(first.knock.knockId).not.toBe(second.knock.knockId);
    expect(knocksStore.size).toBe(2);
  });
});

describe('listPendingKnocksForTarget', () => {
  it('lists only pending, unexpired knocks for the given target', async () => {
    await submitKnock(VALID_INPUT);
    await submitKnock({ ...VALID_INPUT, publicKey: OTHER_PUBLIC_KEY });

    const list = await listPendingKnocksForTarget(TARGET_DID);
    expect(list).toHaveLength(2);
  });

  it('excludes expired knocks', async () => {
    await submitKnock(VALID_INPUT);
    for (const row of knocksStore.values()) row.expiresAt = new Date(Date.now() - 1000);

    await expect(listPendingKnocksForTarget(TARGET_DID)).resolves.toEqual([]);
  });

  it('excludes knocks declared to a different target', async () => {
    await expect(listPendingKnocksForTarget('did:imajin:someone-else')).resolves.toEqual([]);
  });

  it('returns an empty list when there is nothing pending', async () => {
    await expect(listPendingKnocksForTarget(TARGET_DID)).resolves.toEqual([]);
  });
});

describe('declineKnock', () => {
  it('discards the request outright — no identity, connection, or attestation is ever created', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');

    const result = await declineKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect(result).toEqual({ declined: true });

    const row = knocksStore.get(submitted.knock.knockId);
    expect(row?.status).toBe('declined');
    expect(identitiesStore.has(submitted.knock.agentDid)).toBe(false);
    expect(connectionsStore.size).toBe(0);
  });

  it('rejects a decline from anyone other than the declared target', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');

    const result = await declineKnock({ knockId: submitted.knock.knockId, requestedBy: 'did:imajin:someone-else' });
    expect(result).toMatchObject({ status: 403 });
  });

  it('returns 404 for a non-existent knock', async () => {
    const result = await declineKnock({ knockId: 'knock_nope', requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 404 });
  });

  it('rejects declining an already-declined knock', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    await declineKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });

    const result = await declineKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 409 });
  });

  it('rejects responding to an expired knock', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    const row = knocksStore.get(submitted.knock.knockId)!;
    row.expiresAt = new Date(Date.now() - 1000);

    const result = await declineKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 409 });
  });
});

describe('acceptKnock — mint-on-accept, zero grants', () => {
  it('mints a new preliminary-tier agent identity and marks the knock accepted', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');

    const result = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect('result' in result).toBe(true);
    if (!('result' in result)) throw new Error('expected result');
    expect(result.result.minted).toBe(true);
    expect(result.result.agentDid).toBe(submitted.knock.agentDid);

    const identity = identitiesStore.get(submitted.knock.agentDid);
    expect(identity).toMatchObject({ subtype: 'agent', scope: 'actor', tier: 'preliminary', publicKey: PUBLIC_KEY });

    const knockRow = knocksStore.get(submitted.knock.knockId);
    expect(knockRow?.status).toBe('accepted');
  });

  it('links the accepting principal to the agent via a connection (born from a principal relationship)', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });

    const [connDidA, connDidB] = [TARGET_DID, submitted.knock.agentDid].sort((a, b) => a.localeCompare(b));
    const connection = connectionsStore.get(`${connDidA}::${connDidB}`);
    expect(connection).toBeTruthy();
  });

  it('does not create a delegation grant — authority requires a separate user-push act (#1882)', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });

    // acceptKnock never touches delegation_grants at all — the only
    // side effects are the identity mint, the connection, and (optionally)
    // the external-identity attestation.
    expect(attestationsStore.size).toBe(0);
  });

  it('reuses the existing identity for a second accepted knock from the same keypair to a different target (multi-tenant)', async () => {
    identitiesStore.set('did:imajin:second-target', { id: 'did:imajin:second-target', scope: 'actor', subtype: 'human', publicKey: 'second', handle: 'second' });

    const first = await submitKnock(VALID_INPUT);
    if (!('knock' in first)) throw new Error('expected knock');
    const firstAccept = await acceptKnock({ knockId: first.knock.knockId, requestedBy: TARGET_DID });
    if (!('result' in firstAccept)) throw new Error('expected result');
    expect(firstAccept.result.minted).toBe(true);

    const second = await submitKnock({ ...VALID_INPUT, declaredTarget: 'did:imajin:second-target' });
    if (!('knock' in second)) throw new Error('expected knock');
    const secondAccept = await acceptKnock({ knockId: second.knock.knockId, requestedBy: 'did:imajin:second-target' });
    if (!('result' in secondAccept)) throw new Error('expected result');

    expect(secondAccept.result.minted).toBe(false);
    expect(secondAccept.result.agentDid).toBe(firstAccept.result.agentDid);
    // Exactly one identity minted for this keypair despite two accepted knocks.
    expect([...identitiesStore.values()].filter((row) => row.publicKey === PUBLIC_KEY)).toHaveLength(1);
  });

  it('rejects accept from anyone other than the declared target', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');

    const result = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: 'did:imajin:someone-else' });
    expect(result).toMatchObject({ status: 403 });
    expect(identitiesStore.has(submitted.knock.agentDid)).toBe(false);
  });

  it('rejects accepting an already-accepted knock', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });

    const result = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 409 });
  });

  it('rejects accepting an expired knock', async () => {
    const submitted = await submitKnock(VALID_INPUT);
    if (!('knock' in submitted)) throw new Error('expected knock');
    const row = knocksStore.get(submitted.knock.knockId)!;
    row.expiresAt = new Date(Date.now() - 1000);

    const result = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 409 });
    expect(identitiesStore.has(submitted.knock.agentDid)).toBe(false);
  });

  it('returns 404 for a non-existent knock', async () => {
    const result = await acceptKnock({ knockId: 'knock_nope', requestedBy: TARGET_DID });
    expect(result).toMatchObject({ status: 404 });
  });

  describe('external DID as attestation', () => {
    it('records the claimed external DID as a mechanical attestation on the newly minted identity', async () => {
      process.env.AUTH_PRIVATE_KEY = 'a'.repeat(64);
      const submitted = await submitKnock({ ...VALID_INPUT, externalDid: 'did:web:boardy.ai' });
      if (!('knock' in submitted)) throw new Error('expected knock');

      await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });

      const attestation = [...attestationsStore.values()].find((row) => row.subjectDid === submitted.knock.agentDid);
      expect(attestation).toMatchObject({
        type: 'agent.external_identity',
        issuerDid: 'did:imajin:platform-node',
        subjectDid: submitted.knock.agentDid,
        payload: { external_did: 'did:web:boardy.ai' },
        attestationStatus: null,
      });
    });

    it('never records an attestation when no external_did was declared', async () => {
      process.env.AUTH_PRIVATE_KEY = 'a'.repeat(64);
      const submitted = await submitKnock(VALID_INPUT);
      if (!('knock' in submitted)) throw new Error('expected knock');

      await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
      expect(attestationsStore.size).toBe(0);
    });

    it('still accepts successfully (identity + connection) when AUTH_PRIVATE_KEY is unset, just skipping the attestation', async () => {
      const submitted = await submitKnock({ ...VALID_INPUT, externalDid: 'did:web:boardy.ai' });
      if (!('knock' in submitted)) throw new Error('expected knock');

      const result = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
      expect('result' in result).toBe(true);
      expect(identitiesStore.has(submitted.knock.agentDid)).toBe(true);
      expect(attestationsStore.size).toBe(0);
    });
  });
});
