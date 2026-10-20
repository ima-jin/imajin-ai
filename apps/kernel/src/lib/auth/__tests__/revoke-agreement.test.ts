import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto } from '@imajin/auth';
const h = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/db', () => ({
  db: { transaction: h.transaction },
  attestations: {}, attestationSignatures: {},
}));
import { revokeAgreement } from '../revoke-agreement';

const org = 'did:imajin:org';
const buyer = 'did:imajin:buyer';
const actor = 'did:imajin:owner';
let agreement: Record<string, unknown>;
let publicKey: string;
let events: Record<string, unknown>[];
function lockedAgreementQuery() {
  const locked = async () => [agreement];
  const limit = () => ({ for: locked });
  const where = () => ({ limit });
  return { from: () => ({ where }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  const keypair = crypto.generateKeypair();
  vi.stubEnv('AUTH_PRIVATE_KEY', keypair.privateKey);
  publicKey = keypair.publicKey;
  agreement = { id: 'att_agreement', type: 'agreement', issuerDid: org, documentHash: 'hash', revokedAt: null };
  events = [];
  h.select.mockImplementationOnce(lockedAgreementQuery).mockImplementation(() => ({
    from: () => ({ where: async () => [
      { signerDid: org, status: 'signed' }, { signerDid: buyer, status: 'signed' },
    ] }),
  }));
  h.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => { Object.assign(agreement, values); },
    }),
  }));
  h.insert.mockImplementation(() => ({
    values: async (values: Record<string, unknown>) => { events.push(values); },
  }));
  h.transaction.mockImplementation(async (operation) => {
    const original = { ...agreement };
    try {
      return await operation({ select: h.select, update: h.update, insert: h.insert });
    } catch (error) {
      agreement = original;
      events = [];
      throw error;
    }
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('agreement revocation', () => {
  it.each([org, buyer])('allows party %s and retains a verifiable signed event', async (effectiveDid) => {
    const result = await revokeAgreement({ attestationId: 'att_agreement', effectiveDid, actingHumanDid: actor });
    expect(result.status).toBe(200);
    expect(agreement).toMatchObject({ type: 'agreement', attestationStatus: 'revoked', revokedAt: expect.any(Date) });
    expect(events).toHaveLength(1);
    const { signature, id, issuedAt } = events[0];
    expect(id).toEqual(expect.any(String));
    expect(events[0]).toMatchObject({
      type: 'agreement.revoked', issuerDid: 'did:imajin:node',
      payload: { agreementId: 'att_agreement', documentHash: 'hash', revokedByDid: effectiveDid, actingHumanDid: actor, signatureKind: 'node-witness' },
    });
    expect(crypto.verifySync(String(signature), canonicalize({
      subject_did: org, type: 'agreement.revoked', context_id: 'att_agreement',
      context_type: 'attestation', payload: events[0].payload, issued_at: (issuedAt as Date).getTime(),
    }), publicKey)).toBe(true);
  });

  it('refuses an unrelated member/counterparty with no writes', async () => {
    expect((await revokeAgreement({ attestationId: 'att_agreement', effectiveDid: 'did:imajin:other', actingHumanDid: actor })).status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('returns 409 without a second event for an already revoked record', async () => {
    agreement.revokedAt = new Date();
    expect((await revokeAgreement({ attestationId: 'att_agreement', effectiveDid: buyer, actingHumanDid: buyer })).status).toBe(409);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('refuses another attestation type', async () => {
    agreement.type = 'vouch';
    expect((await revokeAgreement({ attestationId: 'att_agreement', effectiveDid: org, actingHumanDid: actor })).status).toBe(404);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('fails closed without a signing key', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await revokeAgreement({ attestationId: 'att_agreement', effectiveDid: org, actingHumanDid: actor })).status).toBe(503);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('rolls back the tombstone if the signed-event insert fails', async () => {
    h.insert.mockImplementation(() => ({ values: async () => { throw new Error('insert failed'); } }));
    await expect(revokeAgreement({ attestationId: 'att_agreement', effectiveDid: org, actingHumanDid: actor })).rejects.toThrow('insert failed');
    expect(agreement.revokedAt).toBeNull();
    expect(events).toHaveLength(0);
  });
});
