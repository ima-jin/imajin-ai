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
    id: 'id', ownerDid: 'ownerDid', purpose: 'purpose', field: 'field', grantId: 'grantId', createdAt: 'createdAt',
  };
  const GRANTS_TABLE = {
    __table: 'grants',
    id: 'id', subject: 'subject', grantedTo: 'grantedTo', purpose: 'purpose', status: 'status',
    field: 'field', expiresAt: 'expiresAt',
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

// Top-level (hoisted) so the vi.mock factory stays inside the nesting budget.
function selectWhere(table: { __table: string }, predicate: Predicate, projection?: Record<string, string>) {
  const rows = project([...storeFor(table).values()].filter(predicate), projection);
  return Object.assign(Promise.resolve(rows), { limit: (n: number) => Promise.resolve(rows.slice(0, n)) });
}

/** An already-executed mutation: awaitable, plus drizzle's `.returning()`. */
function withReturning(rows: Row[]) {
  return Object.assign(Promise.resolve([]), {
    returning: (projection?: Record<string, string>) => Promise.resolve(project(rows, projection)),
  });
}

function patchWhere(table: { __table: string }, patch: Row, predicate: Predicate): Row[] {
  const store = storeFor(table);
  const touched: Row[] = [];
  for (const [key, row] of store) {
    if (predicate(row)) {
      const next = { ...row, ...patch };
      store.set(key, next);
      touched.push(next);
    }
  }
  return touched;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  const isNull = (column: string): Predicate => (row) => row[column] === null || row[column] === undefined;
  return { ...actual, eq, and, isNull };
});

vi.mock('@/src/db', () => ({
  db: {
    select: (projection?: Record<string, string>) => ({
      from: (table: { __table: string }) => ({
        where: (predicate: Predicate) => selectWhere(table, predicate, projection),
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
        onConflictDoUpdate: (opts: { set: Row }) => {
          const key = `${String(data.ownerDid)}::${String(data.purpose)}`;
          const existing = provisionsStore.get(key);
          provisionsStore.set(key, existing ? { ...existing, ...opts.set } : { ...data });
          return Promise.resolve([]);
        },
      }),
    }),
    update: (table: { __table: string }) => ({
      set: (patch: Row) => ({
        where: (predicate: Predicate) => {
          return withReturning(patchWhere(table, patch, predicate));
        },
      }),
    }),
    delete: (table: { __table: string }) => ({
      where: (predicate: Predicate) => {
        const store = storeFor(table);
        const deleted: Row[] = [];
        for (const [key, row] of store) {
          if (predicate(row)) {
            store.delete(key);
            deleted.push(row);
          }
        }
        return withReturning(deleted);
      },
    }),
  },
  internalSecretProvisions: PROVISIONS_TABLE,
  vaultDelegationGrants: GRANTS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

const {
  sealAndGrantStaticSecretMock, fetchGrantSecretMock, ackGrantMock, loadAndUnsealMock, clearSelfGrantExpiryMock,
  subscriptions, warnMock, errorMock,
} = vi.hoisted(() => ({
  sealAndGrantStaticSecretMock: vi.fn(),
  fetchGrantSecretMock: vi.fn(),
  ackGrantMock: vi.fn(),
  loadAndUnsealMock: vi.fn(),
  clearSelfGrantExpiryMock: vi.fn(),
  subscriptions: new Map<string, Array<() => void>>(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

/** Same predicate the real `activeGrantTuple` builds, over the in-memory grants store. */
function activeGrantTupleDouble(tuple: { subject: string; grantedTo: string; field: string }): Predicate {
  return (row) =>
    row.status === 'active' && row.subject === tuple.subject && row.grantedTo === tuple.grantedTo && row.field === tuple.field;
}

vi.mock('../index', () => ({
  sealAndGrantStaticSecret: sealAndGrantStaticSecretMock,
  fetchGrantSecret: fetchGrantSecretMock,
  ackGrant: ackGrantMock,
  loadAndUnseal: loadAndUnsealMock,
  clearSelfGrantExpiry: clearSelfGrantExpiryMock,
  activeGrantTuple: activeGrantTupleDouble,
}));

// #2446 fix 3 — capture the vault hot-reload subscriptions getInternalSecret registers.
vi.mock('../subscribe', () => ({
  ensureVaultHotReloadReactorRegistered: vi.fn(),
  subscribeToSecret: (field: string, callback: () => void) => {
    subscriptions.set(field, [...(subscriptions.get(field) ?? []), callback]);
    return () => undefined;
  },
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
  createLogger: () => ({ info: vi.fn(), warn: warnMock, error: errorMock }),
}));

import {
  getInternalSecret,
  getOrGenerateInternalSecret,
  internalSecretField,
  invalidateInternalSecret,
  isInternalSecretField,
  purposeFromInternalSecretField,
  _resetInternalSecretCacheForTests,
} from '../internal-secret';
import { IntegrityErrorCode, VaultIntegrityError } from '@imajin/vault-core';

const NODE_DID = 'did:imajin:node-test';
const PURPOSE = 'kernel.foreign-principal-pepper';
const FIELD = internalSecretField(PURPOSE);

beforeEach(() => {
  provisionsStore.clear();
  grantsStore.clear();
  subscriptions.clear();
  warnMock.mockReset();
  errorMock.mockReset();
  loadAndUnsealMock.mockReset().mockResolvedValue(undefined);
  clearSelfGrantExpiryMock.mockReset().mockResolvedValue({ status: 'none' });
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

describe('getOrGenerateInternalSecret — custom generator (#2291)', () => {
  it('uses the supplied generator instead of random bytes on first provisioning', async () => {
    const generate = vi.fn(() => JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }));

    const value = await getOrGenerateInternalSecret('notify.web-push-vapid-keys', generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(value).toBe(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }));
    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledWith(
      internalSecretField('notify.web-push-vapid-keys'),
      value,
      expect.objectContaining({ principalDid: NODE_DID, granteeDid: NODE_DID }),
    );
  });

  it('never calls the generator when an active grant already exists — fetches instead', async () => {
    grantsStore.set('vdg_existing', {
      id: 'vdg_existing', subject: NODE_DID, grantedTo: NODE_DID, purpose: 'notify.web-push-vapid-keys', status: 'active',
    });
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'existing-vapid-json', grant: { id: 'vdg_existing' } });
    const generate = vi.fn(() => 'should-never-be-used');

    const value = await getOrGenerateInternalSecret('notify.web-push-vapid-keys', generate);

    expect(value).toBe('existing-vapid-json');
    expect(generate).not.toHaveBeenCalled();
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
  });

  it('caches independently of getInternalSecret\'s default-generator purpose namespace', async () => {
    const generate = () => 'custom-value';

    const first = await getOrGenerateInternalSecret('purpose-custom', generate);
    const second = await getOrGenerateInternalSecret('purpose-custom', generate);

    expect(first).toBe('custom-value');
    expect(second).toBe('custom-value');
    expect(sealAndGrantStaticSecretMock).toHaveBeenCalledTimes(1);
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

describe('internal-secret field helpers (#2446)', () => {
  it('recognises and inverts internal-secret fields', () => {
    expect(isInternalSecretField(FIELD)).toBe(true);
    expect(isInternalSecretField('internal-secret:')).toBe(false);
    expect(isInternalSecretField('github-oauth:did:x')).toBe(false);
    expect(purposeFromInternalSecretField(FIELD)).toBe(PURPOSE);
    expect(() => purposeFromInternalSecretField('github-oauth:did:x')).toThrow(/not an internal-secret field/);
  });
});

describe('getInternalSecret — rotation pickup without restart (#2446 fix 3)', () => {
  it('subscribes once per purpose, and a rotate event on the field drops the cached value', async () => {
    const first = await getInternalSecret(PURPOSE);
    await getInternalSecret(PURPOSE);
    expect(subscriptions.get(FIELD)).toHaveLength(1);

    for (const callback of subscriptions.get(FIELD) ?? []) callback();
    sealAndGrantStaticSecretMock.mockClear();
    grantsStore.set('vdg_rotated', { id: 'vdg_rotated', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active' });
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'rotated-value' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('rotated-value');
    expect(first).not.toBe('rotated-value');
  });

  it('invalidateInternalSecret forces the next call to re-resolve', async () => {
    grantsStore.set('vdg_a', { id: 'vdg_a', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active' });
    fetchGrantSecretMock.mockResolvedValueOnce({ status: 'ok', value: 'one' }).mockResolvedValueOnce({ status: 'ok', value: 'two' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('one');
    await expect(getInternalSecret(PURPOSE)).resolves.toBe('one');
    invalidateInternalSecret(PURPOSE);
    await expect(getInternalSecret(PURPOSE)).resolves.toBe('two');
  });
});

describe('getInternalSecret — no purpose-tagged grant: adopt before generating (#2446 fix 1+2)', () => {
  const claimKey = `${NODE_DID}::${PURPOSE}`;
  const untagged = () => ({
    id: 'vdg_untagged', subject: NODE_DID, grantedTo: NODE_DID, field: FIELD, purpose: null, status: 'active', expiresAt: null,
  });

  it('prod state (row deleted by hand, readable untagged self-grant): re-tags in place, keeps the value, no re-seal', async () => {
    grantsStore.set('vdg_untagged', untagged());
    loadAndUnsealMock.mockResolvedValue('operator-rotated-value');

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('operator-rotated-value');
    await getInternalSecret(PURPOSE);

    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(grantsStore.get('vdg_untagged')?.purpose).toBe(PURPOSE);
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_untagged');
    expect(emitAttestationMock).not.toHaveBeenCalled(); // adopted, not generated
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('stranded row (recorded grant superseded): same re-tag, no re-seal', async () => {
    provisionsStore.set(claimKey, { id: 'isp_old', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: 'vdg_superseded' });
    grantsStore.set('vdg_untagged', untagged());
    loadAndUnsealMock.mockResolvedValue('operator-rotated-value');

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('operator-rotated-value');

    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_untagged');
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('generates fresh only when nothing is readable, and ERRORs naming the grantees left on a dead key', async () => {
    provisionsStore.set(claimKey, { id: 'isp_old', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: 'vdg_revoked' });
    grantsStore.set('vdg_corpus', {
      id: 'vdg_corpus', subject: NODE_DID, grantedTo: 'did:imajin:corpus', field: FIELD, purpose: PURPOSE, status: 'active',
    });

    const value = await getInternalSecret(PURPOSE);

    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_generated');
    expect(emitAttestationMock).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ staleGrantees: ['did:imajin:corpus'] }),
      expect.stringMatching(/re-granted by an operator/),
    );
  });

  it('first boot with nothing in the vault generates quietly (no WARN, no ERROR)', async () => {
    await expect(getInternalSecret(PURPOSE)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(warnMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('tampered entry: the integrity error surfaces, nothing is regenerated, and the claim row survives', async () => {
    grantsStore.set('vdg_untagged', untagged());
    loadAndUnsealMock.mockRejectedValue(
      new VaultIntegrityError(IntegrityErrorCode.KEY_ID_MISMATCH, 'integrity violation', { entryField: FIELD }),
    );

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/integrity violation/);

    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(provisionsStore.has(claimKey)).toBe(true);
    expect(grantsStore.get('vdg_untagged')?.purpose).toBeNull();
  });

  it('an ordinary failure while generating still rolls the claim back for an immediate retry', async () => {
    sealAndGrantStaticSecretMock.mockRejectedValueOnce(new Error('db hiccup'));

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/db hiccup/);
    expect(provisionsStore.has(claimKey)).toBe(false);
  });

  it('re-tag race: a grant another process already tagged is adopted, not re-tagged twice', async () => {
    grantsStore.set('vdg_untagged', untagged());
    loadAndUnsealMock.mockImplementation(async () => {
      // The other process wins the re-tag between our read and our update.
      grantsStore.set('vdg_untagged', { ...untagged(), purpose: PURPOSE });
      return 'operator-rotated-value';
    });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('operator-rotated-value');
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_untagged');
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
  });
});

describe('getInternalSecret — the node\'s own grant never silently expires (#2451)', () => {
  const claimKey = `${NODE_DID}::${PURPOSE}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expiringUntagged = () => ({
    id: 'vdg_untagged', subject: NODE_DID, grantedTo: NODE_DID, field: FIELD, purpose: null, status: 'active', expiresAt: expiry,
  });

  it('re-tag of an expiring self-grant clears its expiry and says so (WARN carries the old date)', async () => {
    grantsStore.set('vdg_untagged', expiringUntagged());
    loadAndUnsealMock.mockResolvedValue('operator-rotated-value');
    clearSelfGrantExpiryMock.mockResolvedValue({ status: 'cleared', previousExpiresAt: expiry });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('operator-rotated-value');

    expect(clearSelfGrantExpiryMock).toHaveBeenCalledTimes(1);
    expect(clearSelfGrantExpiryMock).toHaveBeenCalledWith('vdg_untagged');
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_untagged');
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ previousExpiresAt: expiry.toISOString() }),
      expect.stringMatching(/cleared it/),
    );
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('a grant an earlier boot already re-tagged but left expiring is healed before it is fetched', async () => {
    grantsStore.set('vdg_tagged', {
      id: 'vdg_tagged', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active', expiresAt: expiry,
    });
    clearSelfGrantExpiryMock.mockResolvedValue({ status: 'cleared', previousExpiresAt: expiry });
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'existing-secret-value' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('existing-secret-value');

    expect(clearSelfGrantExpiryMock).toHaveBeenCalledWith('vdg_tagged');
    expect(clearSelfGrantExpiryMock.mock.invocationCallOrder[0]).toBeLessThan(fetchGrantSecretMock.mock.invocationCallOrder[0]!);
  });

  it('a non-expiring self-grant is left alone and a healthy boot stays quiet', async () => {
    grantsStore.set('vdg_tagged', {
      id: 'vdg_tagged', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active', expiresAt: null,
    });
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'existing-secret-value' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('existing-secret-value');

    expect(clearSelfGrantExpiryMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('where the node cannot re-sign (Tier 1 etc.) it WARNs with the expiry date and carries on', async () => {
    grantsStore.set('vdg_tagged', {
      id: 'vdg_tagged', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active', expiresAt: expiry,
    });
    clearSelfGrantExpiryMock.mockResolvedValue({ status: 'blocked', expiresAt: expiry, reason: 'tier1' });
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'existing-secret-value' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('existing-secret-value');

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: expiry.toISOString(), reason: 'tier1' }),
      expect.stringMatching(/rotate it from \/admin\/vault/),
    );
  });

  it('a failure while clearing the expiry never blocks the boot from reading its secret', async () => {
    grantsStore.set('vdg_tagged', {
      id: 'vdg_tagged', subject: NODE_DID, grantedTo: NODE_DID, purpose: PURPOSE, status: 'active', expiresAt: expiry,
    });
    clearSelfGrantExpiryMock.mockRejectedValue(new Error('db hiccup'));
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'existing-secret-value' });

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('existing-secret-value');

    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'vdg_tagged' }),
      expect.stringMatching(/could not clear the self-grant expiry/),
    );
  });
});

describe('getInternalSecret — stale / live claims (#2446 fix 2)', () => {
  const claimKey = `${NODE_DID}::${PURPOSE}`;

  it('re-claims a crashed winner\'s stale claim (no grant, older than the stale window)', async () => {
    provisionsStore.set(claimKey, {
      id: 'isp_crashed', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: null,
      createdAt: new Date(Date.now() - 5 * 60_000),
    });

    await expect(getInternalSecret(PURPOSE)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(provisionsStore.get(claimKey)?.grantId).toBe('vdg_generated');
  });

  it('a FRESH claim with no grant yet is a live race — still polls, never re-provisions', async () => {
    provisionsStore.set(claimKey, {
      id: 'isp_live', ownerDid: NODE_DID, purpose: PURPOSE, field: FIELD, grantId: null, createdAt: new Date(),
    });

    await expect(getInternalSecret(PURPOSE)).rejects.toThrow(/lost the provisioning race/);
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(provisionsStore.get(claimKey)?.id).toBe('isp_live');
  });
});

// #2081 — node key rotation. The vault signing DID is a function of the key, so the
// swap changes `ownerDid`; the sweep re-seals fields under the new identity but never
// touches `internal_secret_provisions`. These tests pin the contract the rotation
// runbook (docs/security/node-key-roles-and-rotation.md, steps 5-7) relies on.
describe('getInternalSecret — node key rotation (#2081): the new DID reuses the reimported value', () => {
  const OLD_DID = 'did:imajin:node-old-key';
  const NEW_DID = 'did:imajin:node-new-key';
  const oldClaimKey = `${OLD_DID}::${PURPOSE}`;
  const newClaimKey = `${NEW_DID}::${PURPOSE}`;

  /** The rows a node that has run on the OLD key leaves behind. */
  function seedOldKeyState() {
    provisionsStore.set(oldClaimKey, { id: 'isp_old', ownerDid: OLD_DID, purpose: PURPOSE, field: FIELD, grantId: 'vdg_old' });
    grantsStore.set('vdg_old', {
      id: 'vdg_old', subject: OLD_DID, grantedTo: OLD_DID, field: FIELD, purpose: PURPOSE, status: 'active', expiresAt: null,
    });
  }

  /** What the Phase 2 reimport leaves: the exported value re-sealed under the NEW identity, untagged. */
  function reimport() {
    grantsStore.set('vdg_reimported', {
      id: 'vdg_reimported', subject: NEW_DID, grantedTo: NEW_DID, field: FIELD, purpose: null, status: 'active', expiresAt: null,
    });
    loadAndUnsealMock.mockResolvedValue('value-exported-from-the-old-key');
  }

  function restartOnKey(did: string) {
    _resetInternalSecretCacheForTests();
    getNodeSigningIdentityMock.mockReturnValue({ senderDid: did, senderPubkey: 'pub', privateKeyHex: 'priv' });
  }

  it('reimport lands first: the new DID adopts the reimported field and generates nothing', async () => {
    seedOldKeyState();
    restartOnKey(NEW_DID);
    reimport();

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('value-exported-from-the-old-key');

    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(emitAttestationMock).not.toHaveBeenCalled();
    expect(grantsStore.get('vdg_reimported')?.purpose).toBe(PURPOSE);
    expect(provisionsStore.get(newClaimKey)?.grantId).toBe('vdg_reimported');
    // The old identity's rows are inert: never read, never rewritten.
    expect(provisionsStore.get(oldClaimKey)?.grantId).toBe('vdg_old');
    expect(grantsStore.get('vdg_old')?.status).toBe('active');
  });

  it('boot before the reimport DOES generate (the window), and the restart after the reimport adopts the reimported value instead', async () => {
    seedOldKeyState();

    // Step 5: the kernel boots on the new key; the old rows belong to the old DID, so nothing resolves.
    restartOnKey(NEW_DID);
    const bootValue = await getInternalSecret(PURPOSE);
    expect(bootValue).toMatch(/^[0-9a-f]{64}$/);
    expect(emitAttestationMock).toHaveBeenCalledTimes(1);
    expect(provisionsStore.get(newClaimKey)?.grantId).toBe('vdg_generated');

    // Step 6: Phase 2 supersedes the boot-time value with the exported one.
    reimport();
    emitAttestationMock.mockClear();
    sealAndGrantStaticSecretMock.mockClear();

    // Step 6b: the second restart. The recorded grant is no longer active, so the row is
    // stranded and the node adopts the readable self-grant — the reimported value wins.
    restartOnKey(NEW_DID);
    const afterRestart = await getInternalSecret(PURPOSE);

    expect(afterRestart).toBe('value-exported-from-the-old-key');
    expect(afterRestart).not.toBe(bootValue);
    expect(sealAndGrantStaticSecretMock).not.toHaveBeenCalled();
    expect(emitAttestationMock).not.toHaveBeenCalled();
    expect(provisionsStore.get(newClaimKey)?.grantId).toBe('vdg_reimported');
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('stays on the reimported value across later restarts (no second adoption, no WARN)', async () => {
    seedOldKeyState();
    restartOnKey(NEW_DID);
    reimport();
    await getInternalSecret(PURPOSE);

    warnMock.mockClear();
    fetchGrantSecretMock.mockResolvedValue({ status: 'ok', value: 'value-exported-from-the-old-key' });
    restartOnKey(NEW_DID);

    await expect(getInternalSecret(PURPOSE)).resolves.toBe('value-exported-from-the-old-key');
    expect(fetchGrantSecretMock).toHaveBeenCalledWith({ grantId: 'vdg_reimported', granteeDid: NEW_DID });
    expect(warnMock).not.toHaveBeenCalled();
  });
});
