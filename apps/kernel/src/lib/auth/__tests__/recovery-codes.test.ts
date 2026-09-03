/**
 * Unit tests for recovery codes (#1250 Phase 1 — the self-custody
 * key-recovery floor).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const {
  identitiesStore, chainsStore, tokensStore, codesStore, attemptsStore, sendMock,
  emitGeneratedMock, emitRedeemedMock,
  IDENTITIES_TABLE, CHAINS_TABLE, TOKENS_TABLE, CODES_TABLE, ATTEMPTS_TABLE,
} = vi.hoisted(() => ({
  identitiesStore: new Map<string, Row>(),
  chainsStore: new Map<string, Row>(),
  tokensStore: new Map<string, Row>(),
  codesStore: new Map<string, Row>(),
  attemptsStore: new Map<string, Row>(),
  sendMock: vi.fn(async () => undefined),
  emitGeneratedMock: vi.fn(async () => undefined),
  emitRedeemedMock: vi.fn(async () => undefined),
  IDENTITIES_TABLE: { __table: 'identities', id: 'id', tier: 'tier', publicKey: 'publicKey', keyRoles: 'keyRoles', updatedAt: 'updatedAt' },
  CHAINS_TABLE: { __table: 'chains', did: 'did', isDeleted: 'isDeleted', updatedAt: 'updatedAt' },
  TOKENS_TABLE: { __table: 'tokens', id: 'id', identityId: 'identityId' },
  CODES_TABLE: { __table: 'codes', id: 'id', did: 'did', codeHash: 'codeHash', usedAt: 'usedAt', invalidatedAt: 'invalidatedAt', createdAt: 'createdAt' },
  ATTEMPTS_TABLE: { __table: 'attempts', id: 'id', did: 'did', ip: 'ip', outcome: 'outcome', createdAt: 'createdAt' },
}));

function storeFor(table: { __table: string }): Map<string, Row> {
  switch (table.__table) {
    case 'identities': return identitiesStore;
    case 'chains': return chainsStore;
    case 'tokens': return tokensStore;
    case 'codes': return codesStore;
    default: return attemptsStore;
  }
}

function keyFor(table: { __table: string }, row: Row): string {
  return table.__table === 'chains' ? String(row.did) : String(row.id);
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const isNull = (column: string): Predicate => (row) => row[column] == null;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, isNull, and };
});

function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
  };
}

vi.mock('@/src/db', () => ({
  db: {
    insert: (table: { __table: string }) => ({
      values: (data: Row | Row[]) => {
        const store = storeFor(table);
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          if (table.__table === 'identities' && store.has(String(row.id))) {
            throw new Error('duplicate key value violates unique constraint');
          }
          store.set(keyFor(table, row), { ...row });
        }
        return Promise.resolve([]);
      },
    }),
    select: () => ({
      from: (table: { __table: string }) => ({
        where: (predicate: Predicate) => queryable([...storeFor(table).values()].filter(predicate)),
        limit: (n: number) => queryable([...storeFor(table).values()].slice(0, n)),
      }),
    }),
    update: (table: { __table: string }) => ({
      set: (patch: Row) => ({
        where: (predicate: Predicate) => {
          const store = storeFor(table);
          if (table.__table === 'identities' && typeof patch.publicKey === 'string') {
            for (const row of store.values()) {
              if (!predicate(row) && row.publicKey === patch.publicKey) {
                throw new Error('duplicate key value violates unique constraint "identities_public_key_key"');
              }
            }
          }
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
        for (const [key, row] of store) if (predicate(row)) store.delete(key);
        return Promise.resolve([]);
      },
    }),
  },
  identities: IDENTITIES_TABLE,
  identityChains: CHAINS_TABLE,
  tokens: TOKENS_TABLE,
  recoveryCodes: CODES_TABLE,
  recoveryAttempts: ATTEMPTS_TABLE,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/notify', () => ({ send: sendMock }));
vi.mock('../emit-recovery-attestation', () => ({
  emitRecoveryCodesGeneratedAttestation: emitGeneratedMock,
  emitRecoveryRedeemedAttestation: emitRedeemedMock,
}));

import {
  generateRecoveryCodePlaintext,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCodeHash,
  generateRecoveryCodes,
  invalidateAllRecoveryCodes,
  redeemRecoveryCode,
  getRecoveryCodeStatus,
  RECOVERY_DISCLOSURE,
} from '../recovery-codes';

const DID = 'did:imajin:recoverable';
const NEW_PUBLIC_KEY = 'b'.repeat(64);
const IP = '203.0.113.7';

function seedIdentity(overrides: Partial<Row> = {}) {
  identitiesStore.set(DID, {
    id: DID,
    tier: 'preliminary',
    publicKey: 'a'.repeat(64),
    keyRoles: null,
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  identitiesStore.clear();
  chainsStore.clear();
  tokensStore.clear();
  codesStore.clear();
  attemptsStore.clear();
  vi.clearAllMocks();
});

// ── Code format ───────────────────────────────────────────────────────────

describe('generateRecoveryCodePlaintext', () => {
  it('produces a Crockford-base32 code grouped in 4-char chunks with no ambiguous characters', () => {
    const code = generateRecoveryCodePlaintext();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    // Never contains visually-ambiguous I, L, O, U.
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('carries at least 128 bits of entropy (28 base32 chars, 5 bits each)', () => {
    const code = generateRecoveryCodePlaintext();
    const undashed = code.replaceAll('-', '');
    expect(undashed.length * 5).toBeGreaterThanOrEqual(128);
  });

  it('generates distinct codes across calls', () => {
    const a = generateRecoveryCodePlaintext();
    const b = generateRecoveryCodePlaintext();
    expect(a).not.toBe(b);
  });
});

describe('normalizeRecoveryCode', () => {
  it('strips dashes/whitespace and upper-cases', () => {
    expect(normalizeRecoveryCode('abcd-efgh-ijkl')).toBe('ABCDEFGHIJKL');
    expect(normalizeRecoveryCode(' ABCD EFGH ')).toBe('ABCDEFGH');
  });
});

// ── Hashing ───────────────────────────────────────────────────────────────

describe('hashRecoveryCode / verifyRecoveryCodeHash', () => {
  it('verifies the correct code', () => {
    const encoded = hashRecoveryCode('ABCD1234');
    expect(verifyRecoveryCodeHash('ABCD1234', encoded)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const encoded = hashRecoveryCode('ABCD1234');
    expect(verifyRecoveryCodeHash('WRONGCODE', encoded)).toBe(false);
  });

  it('never stores the plaintext code in the encoded hash', () => {
    const code = 'SUPERSECRETCODE';
    const encoded = hashRecoveryCode(code);
    expect(encoded).not.toContain(code);
    expect(encoded.startsWith('scrypt$')).toBe(true);
  });

  it('produces a different encoded hash each time (random salt)', () => {
    const a = hashRecoveryCode('SAMECODE');
    const b = hashRecoveryCode('SAMECODE');
    expect(a).not.toBe(b);
    // ...but both still verify against the same plaintext.
    expect(verifyRecoveryCodeHash('SAMECODE', a)).toBe(true);
    expect(verifyRecoveryCodeHash('SAMECODE', b)).toBe(true);
  });

  it('rejects malformed encoded hashes rather than throwing', () => {
    expect(verifyRecoveryCodeHash('anything', 'not-a-real-hash')).toBe(false);
  });
});

// ── Generation / storage ────────────────────────────────────────────────

describe('generateRecoveryCodes', () => {
  it('generates the default count of codes with hashed (non-plaintext) storage', async () => {
    const codes = await generateRecoveryCodes(DID);
    expect(codes).toHaveLength(10);

    const rows = [...codesStore.values()];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.codeHash).not.toEqual(expect.stringContaining(String(row.did)));
      for (const plain of codes) {
        expect(String(row.codeHash)).not.toContain(plain.replaceAll('-', ''));
      }
    }
  });

  it('emits a recovery.codes.generated attestation carrying only the count', async () => {
    await generateRecoveryCodes(DID, 6);
    expect(emitGeneratedMock).toHaveBeenCalledWith({ did: DID, count: 6 });
  });

  it('respects a requested count, clamped to [4, 20]', async () => {
    await expect(generateRecoveryCodes(DID, 3)).resolves.toHaveLength(4);
    await expect(generateRecoveryCodes(DID, 50)).resolves.toHaveLength(20);
    await expect(generateRecoveryCodes(DID, 6)).resolves.toHaveLength(6);
  });

  it('regeneration invalidates the previously-active set', async () => {
    await generateRecoveryCodes(DID, 4);
    const firstBatchIds = [...codesStore.keys()];

    await generateRecoveryCodes(DID, 4);

    for (const id of firstBatchIds) {
      expect((codesStore.get(id) as Row).invalidatedAt).not.toBeNull();
    }
    const activeNow = [...codesStore.values()].filter((r) => !r.usedAt && !r.invalidatedAt);
    expect(activeNow).toHaveLength(4);
  });
});

// ── Status ────────────────────────────────────────────────────────────────

describe('getRecoveryCodeStatus', () => {
  it('reports zero remaining and a null generatedAt when no codes have ever been generated', async () => {
    await expect(getRecoveryCodeStatus(DID)).resolves.toEqual({ remaining: 0, generatedAt: null });
  });

  it('reports the active count and generation time, never the codes themselves', async () => {
    await generateRecoveryCodes(DID, 5);
    const status = await getRecoveryCodeStatus(DID);
    expect(status.remaining).toBe(5);
    expect(status.generatedAt).not.toBeNull();
    expect(JSON.stringify(status)).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
  });

  it('excludes used/invalidated codes from the remaining count', async () => {
    seedIdentity();
    const codes = await generateRecoveryCodes(DID, 4);
    await redeemRecoveryCode({ did: DID, code: codes[0], newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });
    await expect(getRecoveryCodeStatus(DID)).resolves.toEqual({ remaining: 0, generatedAt: null });
  });
});

// ── Bulk invalidation ─────────────────────────────────────────────────────

describe('invalidateAllRecoveryCodes', () => {
  it('marks every active code invalidated and leaves already-used/invalidated codes untouched', async () => {
    await generateRecoveryCodes(DID, 4);
    const [firstId] = [...codesStore.keys()];
    codesStore.set(firstId, { ...(codesStore.get(firstId) as Row), usedAt: new Date('2020-01-01') });

    await invalidateAllRecoveryCodes(DID);

    const rows = [...codesStore.values()];
    for (const row of rows) {
      if (row.id === firstId) {
        expect(row.invalidatedAt).toBeFalsy();
        expect(row.usedAt).not.toBeFalsy();
      } else {
        expect(row.invalidatedAt).not.toBeFalsy();
      }
    }
  });
});

// ── Redemption (recovery-authorized rotation) ────────────────────────────

describe('redeemRecoveryCode', () => {
  it('happy path: rotates the key, invalidates all codes, clears sessions, audits success, and notifies', async () => {
    seedIdentity();
    const codes = await generateRecoveryCodes(DID, 4);
    tokensStore.set('tok_1', { id: 'tok_1', identityId: DID });
    chainsStore.set(DID, { did: DID, isDeleted: false, updatedAt: new Date() });

    const result = await redeemRecoveryCode({ did: DID, code: codes[0], newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });

    expect(result).toMatchObject({ ok: true, sessionsInvalidated: true, chainDeprecated: true, disclosure: RECOVERY_DISCLOSURE });
    expect((identitiesStore.get(DID) as Row).publicKey).toBe(NEW_PUBLIC_KEY);
    expect((identitiesStore.get(DID) as Row).keyRoles).toBeNull();
    expect((chainsStore.get(DID) as Row).isDeleted).toBe(true);
    expect(tokensStore.size).toBe(0);

    const activeAfter = [...codesStore.values()].filter((r) => !r.usedAt && !r.invalidatedAt);
    expect(activeAfter).toHaveLength(0);

    const attempts = [...attemptsStore.values()];
    expect(attempts.some((a) => a.outcome === 'success' && a.did === DID)).toBe(true);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: DID, scope: 'auth:recovery-code-used' }),
    );
    expect(emitRedeemedMock).toHaveBeenCalledWith({ did: DID });
  });

  it('wrong code: rejects and audits invalid_code without mutating identity or tokens', async () => {
    seedIdentity();
    await generateRecoveryCodes(DID, 4);
    tokensStore.set('tok_1', { id: 'tok_1', identityId: DID });
    const originalKey = (identitiesStore.get(DID) as Row).publicKey;

    const result = await redeemRecoveryCode({ did: DID, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });

    expect(result).toEqual({ ok: false, reason: 'invalid_code' });
    expect((identitiesStore.get(DID) as Row).publicKey).toBe(originalKey);
    expect(tokensStore.size).toBe(1);
    expect([...attemptsStore.values()].some((a) => a.outcome === 'invalid_code')).toBe(true);
  });

  it('reused code: a code already redeemed cannot be redeemed again', async () => {
    seedIdentity();
    const codes = await generateRecoveryCodes(DID, 4);

    const first = await redeemRecoveryCode({ did: DID, code: codes[0], newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });
    expect(first.ok).toBe(true);

    // A second identity re-seeded so the "not found" path doesn't mask reuse.
    seedIdentity({ publicKey: NEW_PUBLIC_KEY });
    const second = await redeemRecoveryCode({ did: DID, code: codes[0], newPublicKeyHex: 'c'.repeat(64), ip: IP });
    expect(second).toEqual({ ok: false, reason: 'no_active_codes' });
  });

  it('rejects when no codes have ever been generated', async () => {
    seedIdentity();
    const result = await redeemRecoveryCode({ did: DID, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });
    expect(result).toEqual({ ok: false, reason: 'no_active_codes' });
  });

  it('rejects a soft (custodial) identity — recovery codes are a self-custody primitive', async () => {
    seedIdentity({ tier: 'soft' });
    await generateRecoveryCodes(DID, 4);
    const result = await redeemRecoveryCode({ did: DID, code: 'anything', newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });
    expect(result).toEqual({ ok: false, reason: 'not_self_custody' });
  });

  it('rejects an unknown DID', async () => {
    const result = await redeemRecoveryCode({ did: 'did:imajin:nobody', code: 'anything', newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });
    expect(result).toEqual({ ok: false, reason: 'identity_not_found' });
  });

  it('rejects a malformed new public key before touching the database', async () => {
    seedIdentity();
    await generateRecoveryCodes(DID, 4);
    const result = await redeemRecoveryCode({ did: DID, code: 'anything', newPublicKeyHex: 'not-hex', ip: IP });
    expect(result).toEqual({ ok: false, reason: 'invalid_public_key' });
  });

  it('surfaces a public key conflict (target key already claimed by another identity) without deleting sessions', async () => {
    seedIdentity();
    const codes = await generateRecoveryCodes(DID, 4);
    tokensStore.set('tok_1', { id: 'tok_1', identityId: DID });
    identitiesStore.set('did:imajin:other', { id: 'did:imajin:other', tier: 'preliminary', publicKey: NEW_PUBLIC_KEY, keyRoles: null, updatedAt: new Date() });

    const result = await redeemRecoveryCode({ did: DID, code: codes[0], newPublicKeyHex: NEW_PUBLIC_KEY, ip: IP });

    expect(result).toEqual({ ok: false, reason: 'public_key_conflict' });
    // The matched code was already marked used before the conflict surfaced —
    // acceptable (single-use enforcement doesn't roll back), but sessions and
    // the identity's own key must be left untouched by the failed rotation.
    expect(tokensStore.size).toBe(1);
    expect((identitiesStore.get(DID) as Row).publicKey).not.toBe(NEW_PUBLIC_KEY);
    expect([...attemptsStore.values()].some((a) => a.outcome === 'public_key_conflict')).toBe(true);
  });
});
