/**
 * Tests for self-provisioned internal secrets (#2245 — first target of the
 * #2241 vault-native-credentials epic, ahead of `ATTESTATION_INTERNAL_API_KEY`).
 *
 * `sealAndGrantStaticSecret` / `fetchGrantSecret` / `ackGrant` (the
 * underlying vault crypto + custody primitives) already have exhaustive
 * coverage elsewhere in this directory (static-secret-grant.test.ts,
 * grant-fetch.test.ts) — these tests mock that boundary and focus purely
 * on internal-secret.ts's own orchestration: generate-vs-fetch decision,
 * the provisioning-claim race, the process-lifetime cache, and the
 * exactly-once attestation/ack contracts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { provisionsStore, grantsStore, PROVISIONS_TABLE, GRANTS_TABLE } = vi.hoisted(() => {
  const provisionsStore = new Map<string, Row>(); // keyed by `${ownerDid}::${purpose}`
  const grantsStore = new Map<string, Row>(); // keyed by grant id
  const PROVISIONS_TABLE = {
    __table: 'provisions',
    id: 'id', ownerDid: 'ownerDid', purpose: 'purpose', field: 'field', grantId: 'grantId',
  };
  const GRANTS_TABLE = {
    __table: 'grants',
    id: 'id', subject: 'subject', grantedTo: 'grantedTo', purpose: 'purpose', status: 'status',
  };
  return { provisionsStore, grantsStore, PROVISIONS_TABLE, GRANTS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  switch (table.__table) {
    case 'provisions': return provisionsStore;
    case 'grants': return grantsStore;
    default: throw new Error(`unknown table ${table.__table}`);
  }
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => {
    const out: Row = {};
    for (const key of Object.keys(projection)) out[key] = row[projection[key]];
    return out;
  });
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, and };
});

vi.mock('@/src/db', () => ({
  db: {
    select: (projection?: Record<string, string>) => ({
      from: (table: { __table: string }) => ({
        where: (predicate: Predicate) => ({
          limit: (n: number) =>
            Promise.resolve(project([...storeFor(table).values()].filter(predicate), projection).slice(0, n)),
        }),
      }),
    }),
    insert: (_table: { __table: string }) => ({
      values: (data: Row) => ({
        onConflictDoNothing: () => ({
          returning: (projection?: Record<string, string>) => {
            const key = `${String(data.ownerDid)}::${String(data.purpose)}`;
            if (provisionsStore.has(key)) return Promise.resolve([]);
            provisionsStore.set(key, { ...data });
            return Promise.resolve(project([{ ...data }], projection));
          },
        }),
      }),
    }),
    update: (table: { __table: string }) => ({
      set: (patch: Row) => ({
        where: (predicate: Predicate) => {
          const store = storeFor(table);
          for (const [key, row] of store) {
            if (predicate(row)) store.set(key, { ...row, ...patch });
          }
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: { __table: string }) => ({
      where: (predicate: Predicate) => {
        const store = storeFor(table);
        for (const [key, row] of store) {
          if (predicate(row)) store.delete(key);
        }
        return Promise.resolve([]);
      },
    }),
  },
  internalSecretProvisions: PROVISIONS_TABLE,
  vaultDelegationGrants: GRANTS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

const { sealAndGrantStaticSecretMock, fetchGrantSecretMock, ackGrantMock } = vi.hoisted(() => ({
  sealAndGrantStaticSecretMock: vi.fn(),
  fetchGrantSecretMock: vi.fn(),
  ackGrantMock: vi.fn(),
}));
vi.mock('../index', () => ({
  sealAndGrantStaticSecret: sealAndGrantStaticSecretMock,
  fetchGrantSecret: fetchGrantSecretMock,
  ackGrant: ackGrantMock,
}));

const getNodeSigningIdentityMock = vi.fn();
vi.mock('../sealing', () => ({
  getNodeSigningIdentity: (...args: unknown[]) => getNodeSigningIdentityMock(...args),
}));

const emitAttestationMock = vi.fn();
vi.mock('@imajin/auth', () => ({
  emitAttestation: (...args: unknown[]) => emitAttestationMock(...args),
}));

const publishMock = vi.fn();
vi.mock('@imajin/bus', () => ({
  publish: (...args: unknown[]) => publishMock(...args),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getInternalSecret, internalSecretField, _resetInternalSecretCacheForTests } from '../internal-secret';

const NODE_DID = 'did:imajin:node-test';
const PURPOSE = 'kernel.foreign-principal-pepper';
const FIELD = internalSecretField(PURPOSE);

beforeEach(() => {
  provisionsStore.clear();
  grantsStore.clear();
  _resetInternalSecretCacheForTests();

  getNodeSigningIdentityMock.mockReset().mockReturnValue({
    senderDid: NODE_DID,
    senderPubkey: 'pub-test',
    privateKeyHex: 'priv-test',
  });
  sealAndGrantStaticSecretMock.mockReset().mockResolvedValue({ entry: {}, grantId: 'vdg_generated', requestId: null });
  fetchGrantSecretMock.mockReset();
  ackGrantMock.mockReset().mockResolvedValue({ status: 'ok', ackedAt: new Date(), ackOutcome: 'used', ownerDid: NODE_DID, purpose: PURPOSE });
  emitAttestationMock.mockReset().mockResolvedValue({});
  publishMock.mockReset().mockResolvedValue(undefined);
});

describe('internalSecretField', () => {
  it('namespaces the vault field under the purpose', () => {
    expect(internalSecretField('kernel.foo')).toBe('internal-secret:kernel.foo');
  });
});

describe('getInternalSecret — generate path (no active grant yet)', () => {
  it('generates on first call, self-granting to the node\'s own DID, and reuses the cached value on every subsequent call', async () => {
    const first = await getInternalSecret(PURPOSE);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledTimes(1);
    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledWith(
      FIELD,
      first,
      expect.objectContaining({ principalDid: NODE_DID, granteeDid: NODE_DID, purpose: PURPOSE, oneTime: false }),
    );

    const second = await getInternalSecret(PURPOSE);
    expect(second).toBe(first);
    // Cache hit — no additional generate, fetch, or ack calls.
    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledTimes(1);
    expect(fetchGrantSecretMock).not.toHaveBeenCalled();
    expect(ackGrantMock).not.toHaveBeenCalled();
  });

  it('emits exactly one vault.secret.generated attestation and bus event, binding only purpose/grantId/contentHash', async () => {
    const value = await getInternalSecret(PURPOSE);
    await getInternalSecret(PURPOSE); // cached — must not re-attest

    expect(emitAttestationMock).toHaveBeenCalledTimes(1);
    const [attestationCall] = emitAttestationMock.mock.calls[0] as [Record<string, unknown>];
    expect(attestationCall).toMatchObject({
      issuer_did: NODE_DID,
      subject_did: NODE_DID,
      type: 'vault.secret.generated',
      context_id: 'vdg_generated',
    });
    const payload = attestationCall.payload as Record<string, unknown>;
    expect(payload.purpose).toBe(PURPOSE);
    expect(payload.grantId).toBe('vdg_generated');
    expect(payload.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain(value); // never the raw bytes

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('vault.secret.generated', expect.objectContaining({
      payload: expect.objectContaining({ purpose: PURPOSE, grantId: 'vdg_generated' }),
    }));
  });

  it('generates independently per purpose', async () => {
    await getInternalSecret('purpose-a');
    await getInternalSecret('purpose-b');

    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledTimes(2);
    expect(emitAttestationMock).toHaveBeenCalledTimes(2);
  });

  it('throws and does not cache a failed generate (Tier 1 returns no grantId), so a later call retries', async () => {
    sealAndGrantStaticSecretMock.mockResolvedValueOnce({ entry: {}, grantId: null, requestId: 'req_1' });

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/no grantId/);
    expect(emitAttestationMock).not.toHaveBeenCalled();

    // Retried on the next call — the failure was not cached, and this time
    // it succeeds (default mock resolves a real grantId).
    const value = await getInternalSecret(PURPOSE);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(emitAttestationMock).toHaveBeenCalledTimes(1);
  });
});

describe('getInternalSecret — fetch path (an active grant already exists)', () => {
  beforeEach(() => {
    grantsStore.set('vdg_existing', {
      id: 'vdg_existing', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active',
    });
    fetchGrantSecretMock.mockResolvedValue({
      status: 'ok',
      value: 'existing-secret-value',
      grant: { id: 'vdg_existing' },
    });
  });

  it('fetches the existing grant and sends exactly one deferred "used" ack per fetch, never generating a new secret', async () => {
    const first = await getInternalSecret(PURPOSE);
    const second = await getInternalSecret(PURPOSE); // cached — no second fetch/ack

    expect(first).toBe('existing-secret-value');
    expect(second).toBe(first);
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(fetchGrantSecretMock).toHaveBeenCalledTimes(1);
    expect(fetchGrantSecretMock).toHaveBeenCalledWith({ grantId: 'vdg_existing', granteeDid: NODE_DID });
    expect(ackGrantMock).toHaveBeenCalledTimes(1);
    expect(ackGrantMock).toHaveBeenCalledWith({ grantId: 'vdg_existing', granteeDid: NODE_DID, outcome: 'used' });
  });

  it('still returns the fetched value even when the (non-fatal) ack itself fails', async () => {
    ackGrantMock.mockRejectedValue(new Error('ack transport failed'));

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('existing-secret-value');
  });

  it('throws when the grant exists but is no longer fetchable', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'expired' });

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/not fetchable/);
  });
});

describe('getInternalSecret — provisioning race (two boots)', () => {
  beforeEach(() => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'winner-secret', grant: { id: 'vdg_winner' } });
  });

  it('when another process already holds the (ownerDid, purpose) claim, this process polls for its active grant instead of generating its own', async () => {
    // Simulate the winner: it already claimed the provisioning slot, and its
    // grant becomes active a few polling intervals later.
    provisionsStore.set(`${NODE_DID}::${PURPOSE}`, { id: 'isp_winner', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: null });
    setTimeout(() => {
      grantsStore.set('vdg_winner', { id: 'vdg_winner', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active' });
    }, 30);

    const value = await getInternalSecret(PURPOSE);

    expect(value).toBe('winner-secret');
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(fetchGrantSecretMock).toHaveBeenCalledTimes(1);
    expect(fetchGrantSecretMock).toHaveBeenCalledWith({ grantId: 'vdg_winner', granteeDid: NODE_DID });
    expect(ackGrantMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('throws if the winning process never finishes provisioning within the poll budget', async () => {
    provisionsStore.set(`${NODE_DID}::${PURPOSE}`, { id: 'isp_stuck', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: null });

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/lost the provisioning race/);
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
  }, 10_000);
});
