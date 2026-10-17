import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  app: { status: 'active', secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' }] },
  grants: [] as Array<Record<string, unknown>>,
  facts: [] as Array<Record<string, unknown>>,
  generate: vi.fn(), grant: vi.fn(), fetch: vi.fn(), rotate: vi.fn(), revoke: vi.fn(),
  attest: vi.fn(), seal: vi.fn(), invalidate: vi.fn(), lock: vi.fn(), tier1: false,
}));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
  and: (...clauses: unknown[]) => clauses,
  asc: (column: string) => column,
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }),
}));
function testQuery(projection: Record<string, unknown> | undefined, conditions: Array<{ column: string; value: unknown }>) {
  const clauses = Array.isArray(conditions) ? conditions : [conditions];
  const rows = state.grants.filter((row) => clauses.every((condition) => row[condition.column] === condition.value));
  return {
    then: (resolve: (data: unknown[]) => void) => resolve(rows),
    limit: () => Promise.resolve([state.app]),
    orderBy: () => Promise.resolve(projection?.payload ? state.facts : []),
  };
}
function testSelect(projection?: Record<string, unknown>) {
  return { from: () => testWhere(projection) };
}
function testWhere(projection?: Record<string, unknown>) {
  return { where: (conditions: Array<{ column: string; value: unknown }>) => testQuery(projection, conditions) };
}
let mutationTail = Promise.resolve();
async function testMutationTransaction(run: (tx: { execute: typeof state.lock }) => Promise<void>) {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await run({ execute: state.lock });
  } finally {
    release();
  }
}
vi.mock('@/src/db', () => {
  const columns = new Proxy({}, { get: (_target, key) => key });
  return {
    registryApps: columns, vaultDelegationGrants: columns, attestations: columns,
    db: {
      select: testSelect,
      transaction: testMutationTransaction,
    },
  };
});
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ emitMechanicalAttestation: state.attest }));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }), isVaultTier1: () => state.tier1,
}));
vi.mock('@/src/lib/vault/internal-secret', () => ({
  getOrGenerateInternalSecret: state.generate, internalSecretField: (purpose: string) => `internal-secret:${purpose}`,
  sealAndRecordInternalSecret: state.seal, invalidateInternalSecret: state.invalidate,
}));
vi.mock('@/src/lib/vault/shared-internal-secret', () => ({ grantInternalSecretTo: state.grant }));
vi.mock('@/src/lib/vault/internal-secret-rotate', () => ({ rotateInternalSecret: state.rotate }));
vi.mock('@/src/lib/vault/internal-secret-revoke', () => ({ revokeInternalSecret: state.revoke }));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: state.fetch }));
import {
  appSecretPurpose, ensureAppDeclaredSecrets, fetchAppDeclaredSecret, listAppDeclaredSecrets,
  revokeAppDeclaredSecret, rotateAppDeclaredSecret, setAppDeclaredSecret,
} from '../self-secrets';

const APP = 'did:imajin:app-under-test';
const AUTH = { approvalId: 'approval_test', operatorDid: 'did:imajin:operator', contentHash: 'fake-hash', decidedAt: '2026-10-14T00:00:00Z' };
function grantRow(status = 'active', appDid = APP) {
  return { id: 'grant_test', subject: 'did:imajin:node', grantedTo: appDid,
    purpose: appSecretPurpose(appDid, 'SESSION_SECRET'), field: `internal-secret:${appSecretPurpose(appDid, 'SESSION_SECRET')}`, status };
}

beforeEach(() => {
  vi.resetAllMocks();
  mutationTail = Promise.resolve();
  state.app = { status: 'active', secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' }] };
  state.grants = []; state.facts = []; state.tier1 = false;
  state.attest.mockResolvedValue('att_test');
  state.lock.mockResolvedValue([{ locked: true }]);
  state.generate.mockImplementation(async (_purpose, generate: () => string) => generate());
  state.grant.mockResolvedValue({ status: 'ok', grantId: 'grant_test' });
  state.fetch.mockResolvedValue({ status: 'ok', value: 'obviously-fake-session-placeholder' });
});

describe('app-scoped existing-vault lifecycle', () => {
  it('serializes two approved sets and refuses the second instead of overwriting the first', async () => {
    state.app.secrets[0].kind = 'operator-supplied';
    state.grant.mockImplementation(async () => {
      state.grants = [grantRow()];
      return { status: 'ok', grantId: 'grant_test' };
    });
    const results = await Promise.allSettled([
      setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'OBVIOUSLY_FAKE_FIRST_INPUT', AUTH),
      setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'OBVIOUSLY_FAKE_SECOND_INPUT', AUTH),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(state.seal).toHaveBeenCalledTimes(1);
    expect(state.seal.mock.calls[0][2]).toBe('OBVIOUSLY_FAKE_FIRST_INPUT');
    expect(state.lock).toHaveBeenCalledTimes(2);
    expect(state.lock.mock.calls[0][0]).toEqual({
      parts: ['SELECT pg_try_advisory_xact_lock(hashtextextended(', ', 0)) AS locked'],
      values: [appSecretPurpose(APP, 'SESSION_SECRET')],
    });
    expect(state.lock.mock.invocationCallOrder[0]).toBeLessThan(state.seal.mock.invocationCallOrder[0]);
  });
  it('does not enter custody when the mutation lock fails', async () => {
    state.lock.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_LOCK_FAILURE'));
    state.app.secrets[0].kind = 'operator-supplied';
    await expect(setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'OBVIOUSLY_FAKE_INPUT', AUTH)).rejects.toThrow();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
  });
  it('refuses a concurrent mutation without waiting or touching custody', async () => {
    state.lock.mockResolvedValueOnce([{ locked: false }]);
    state.app.secrets[0].kind = 'operator-supplied';
    await expect(setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'OBVIOUSLY_FAKE_INPUT', AUTH)).rejects.toThrow('busy');
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
  });
  it('leaves operator declarations missing on sync/claim and rejects generated rotation', async () => {
    state.app.secrets[0].kind = 'operator-supplied';
    await ensureAppDeclaredSecrets(APP, AUTH);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
    await expect(rotateAppDeclaredSecret(APP, 'SESSION_SECRET', AUTH)).rejects.toThrow('Operator input required');
  });
  it('sets supplied input through custody without generation or plaintext hashes in audit', async () => {
    state.app.secrets[0].kind = 'operator-supplied';
    await setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'OBVIOUSLY_FAKE_OPERATOR_INPUT', AUTH);
    expect(state.seal).toHaveBeenCalledWith('did:imajin:node', appSecretPurpose(APP, 'SESSION_SECRET'), 'OBVIOUSLY_FAKE_OPERATOR_INPUT');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.grant).toHaveBeenCalled();
    expect(state.attest.mock.calls.map(([fact]) => fact.payload.phase)).toEqual(['minted', 'granted']);
    expect(JSON.stringify(state.attest.mock.calls)).not.toContain('OBVIOUSLY_FAKE_OPERATOR_INPUT');
    for (const [fact] of state.attest.mock.calls) expect(fact.payload).not.toHaveProperty('contentHash');
  });
  it('rotates supplied input using existing regrant custody and never generates', async () => {
    state.app.secrets[0].kind = 'operator-supplied';
    state.grants = [grantRow()];
    await setAppDeclaredSecret(APP, 'SESSION_SECRET', 'rotate', 'OBVIOUSLY_FAKE_REPLACEMENT', AUTH);
    expect(state.rotate).toHaveBeenCalledWith(grantRow().field, 'OBVIOUSLY_FAKE_REPLACEMENT');
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.attest.mock.calls.at(-1)?.[0].payload.phase).toBe('rotated');
  });
  it('refuses set/rotate state drift and non-operator declarations', async () => {
    await expect(setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'FAKE_INPUT', AUTH)).rejects.toThrow('not accepted');
    state.app.secrets[0].kind = 'operator-supplied';
    await expect(setAppDeclaredSecret(APP, 'SESSION_SECRET', 'rotate', 'FAKE_INPUT', AUTH)).rejects.toThrow('state changed');
    state.grants = [grantRow()];
    await expect(setAppDeclaredSecret(APP, 'SESSION_SECRET', 'set', 'FAKE_INPUT', AUTH)).rejects.toThrow('state changed');
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.rotate).not.toHaveBeenCalled();
  });
  it('issues missing declared secrets without returning bytes; signed facts contain only metadata', async () => {
    const result = await ensureAppDeclaredSecrets(APP, AUTH);
    expect(result).toBeUndefined();
    expect(state.generate).toHaveBeenCalledWith(appSecretPurpose(APP, 'SESSION_SECRET'), expect.any(Function));
    const generated = await state.generate.mock.results[0].value;
    expect(generated).toHaveLength(64);
    expect(JSON.stringify(state.attest.mock.calls).includes(generated)).toBe(false);
    expect(state.grant).toHaveBeenCalledWith(appSecretPurpose(APP, 'SESSION_SECRET'), APP, 'did:imajin:node');
    expect(state.attest.mock.calls.map(([fact]) => fact.payload.phase)).toEqual(['minted', 'granted']);
    expect(state.attest.mock.calls[1][0].payload.authorizedBy).toEqual(AUTH);
  });

  it.each(['active', 'revoked'])('does not re-mint or resurrect a %s app grant on re-sync/claim', async (status) => {
    state.grants = [grantRow(status)];
    await ensureAppDeclaredSecrets(APP);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
  });

  it('refuses unsupported custody before generating any value', async () => {
    state.tier1 = true;
    await expect(ensureAppDeclaredSecrets(APP)).rejects.toThrow('Tier 0');
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('refuses inactive apps, invalid recipes, undeclared names and foreign grants before decrypt', async () => {
    state.app.status = 'revoked';
    await expect(fetchAppDeclaredSecret(APP, 'SESSION_SECRET')).rejects.toThrow('refused');
    state.app.status = 'active';
    state.app.secrets[0].kind = 'invalid-kind';
    await expect(ensureAppDeclaredSecrets(APP)).rejects.toThrow('invalid');
    state.app.secrets[0].kind = 'random-32B';
    await expect(fetchAppDeclaredSecret(APP, 'UNDECLARED')).rejects.toThrow('refused');
    state.grants = [grantRow('active', 'did:imajin:other-app')];
    await expect(fetchAppDeclaredSecret(APP, 'SESSION_SECRET')).rejects.toThrow('refused');
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('fetches only the current own grant, recording fetched without the value', async () => {
    state.grants = [grantRow()];
    const result = await fetchAppDeclaredSecret(APP, 'SESSION_SECRET');
    expect(result.grantId).toBe('grant_test');
    expect(state.fetch).toHaveBeenCalledWith({ grantId: 'grant_test', granteeDid: APP });
    expect(JSON.stringify(state.attest.mock.calls).includes(result.value)).toBe(false);
    state.fetch.mockResolvedValue({ status: 'inactive' });
    await expect(fetchAppDeclaredSecret(APP, 'SESSION_SECRET')).rejects.toThrow('refused');
  });

  it('rotates through the existing transaction/regrant primitive and records operator provenance', async () => {
    state.grants = [grantRow()];
    await rotateAppDeclaredSecret(APP, 'SESSION_SECRET', AUTH);
    expect(state.rotate.mock.calls[0][0]).toBe(grantRow().field);
    expect(state.rotate.mock.calls[0][1]).toHaveLength(64);
    expect(state.attest.mock.calls.map(([fact]) => fact.payload.phase)).toEqual(['minted', 'granted', 'rotated']);
    expect(state.attest.mock.calls[2][0].payload.authorizedBy).toEqual(AUTH);
    expect(JSON.stringify(state.attest.mock.calls).includes(state.rotate.mock.calls[0][1])).toBe(false);
  });

  it('refuses a missing rotation and atomically withdraws node and app grants using internal revoke', async () => {
    await expect(rotateAppDeclaredSecret(APP, 'SESSION_SECRET', AUTH)).rejects.toThrow('not active');
    expect(state.rotate).not.toHaveBeenCalled();
    await revokeAppDeclaredSecret(APP, 'SESSION_SECRET', AUTH);
    expect(state.revoke).toHaveBeenCalledWith(appSecretPurpose(APP, 'SESSION_SECRET'), { revokeExternal: true });
    expect(state.attest.mock.calls[0][0].payload.phase).toBe('revoked');
  });

  it('projects whitelisted timeline facts, never arbitrary payloads or values', async () => {
    state.grants = [grantRow()];
    state.facts = [
      { issuedAt: new Date(), payload: { phase: 'rotated', grantId: 'grant_test', authorizedBy: AUTH, value: 'obviously-fake-session-placeholder' } },
      { issuedAt: new Date(), payload: { phase: 'unknown' } },
    ];
    const metadata = await listAppDeclaredSecrets(APP);
    expect(metadata[0].status).toBe('active');
    expect(metadata[0].timeline).toHaveLength(1);
    expect(metadata[0].timeline[0].operatorDid).toBe(AUTH.operatorDid);
    expect(metadata[0].timeline[0].via).toBe(AUTH.approvalId);
    expect(JSON.stringify(metadata)).not.toContain('obviously-fake-session-placeholder');
  });

  it('fails closed with a redacted error if signed auditing is unavailable', async () => {
    state.grant.mockResolvedValue({ status: 'tier1_unsupported' });
    await expect(ensureAppDeclaredSecrets(APP)).rejects.toThrow('unavailable');
    state.grant.mockResolvedValue({ status: 'ok', grantId: 'grant_test' });
    state.attest.mockRejectedValue(new Error('obviously-fake-provider-placeholder'));
    await expect(ensureAppDeclaredSecrets(APP)).rejects.toThrow('App secret audit unavailable');
  });
  it('repairs missing signed issuance facts without re-minting, then skips already-recorded facts', async () => {
    state.grants = [grantRow()];
    await ensureAppDeclaredSecrets(APP, AUTH);
    expect(state.attest).toHaveBeenCalledTimes(2);
    expect(state.generate).not.toHaveBeenCalled();
    state.facts = state.attest.mock.calls.map(([fact]) => ({ payload: fact.payload }));
    state.attest.mockClear();
    await ensureAppDeclaredSecrets(APP, AUTH);
    expect(state.attest).not.toHaveBeenCalled();
    state.facts = [];
    state.attest.mockResolvedValue(null);
    await expect(ensureAppDeclaredSecrets(APP)).rejects.toThrow('audit unavailable');
  });
  it('adopts the active-grant uniqueness winner during concurrent issuance', async () => {
    state.grant.mockImplementationOnce(async () => {
      state.grants = [grantRow()];
      throw Object.assign(new Error('duplicate grant'), { code: '23505' });
    });
    await ensureAppDeclaredSecrets(APP);
    expect(state.attest.mock.calls[0][0].payload.grantId).toBe('grant_test');
  });
});
