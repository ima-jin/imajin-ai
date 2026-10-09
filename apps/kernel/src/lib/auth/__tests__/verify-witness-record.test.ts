/**
 * Tests for the S5 witness-record verifier (#2684). Real @imajin/auth crypto;
 * only the stored `key.rotated` payloads, the node DID and the node's current
 * signing identity are faked. Every negative case must fail closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, createKeyRotatedPayload, crypto as authCrypto } from '@imajin/auth';

const h = vi.hoisted(() => ({
  loadStoredRotationPayloads: vi.fn(),
  resolveNodeDid: vi.fn(),
  getNodeSigningIdentity: vi.fn(),
}));

vi.mock('../node-key-rotation', () => ({ loadStoredRotationPayloads: h.loadStoredRotationPayloads }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ resolveNodeDid: h.resolveNodeDid }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: h.getNodeSigningIdentity }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { verifyOperatorApprovalWitnessRecord, verifyWitnessRecord } from '../verify-witness-record';

const NODE_DID = 'did:imajin:test-node';
const ROTATED_AT = new Date('2026-09-01T00:00:00.000Z');
const BEFORE = '2026-06-01T00:00:00.000Z';
const AFTER = '2026-10-01T00:00:00.000Z';
const MESSAGE = 'canonical witness payload';

interface Keys {
  privateKey: string;
  publicKey: string;
}

/** Node at `current` with a recorded `previous -> current` rotation effective at ROTATED_AT. */
function rotatedNode(): { previous: Keys; current: Keys } {
  const previous = authCrypto.generateKeypair();
  const current = authCrypto.generateKeypair();
  h.loadStoredRotationPayloads.mockResolvedValue([
    createKeyRotatedPayload({ oldPrivateKey: previous.privateKey, newPrivateKey: current.privateKey, effectiveAt: ROTATED_AT }),
  ]);
  h.getNodeSigningIdentity.mockReturnValue({ senderPubkey: current.publicKey });
  return { previous, current };
}

function record(signer: Keys, witnessedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    message: MESSAGE,
    signature: authCrypto.signSync(MESSAGE, signer.privateKey),
    senderPubkey: signer.publicKey,
    witnessedAt,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveNodeDid.mockResolvedValue({ did: NODE_DID, source: 'relay_config' });
  h.loadStoredRotationPayloads.mockResolvedValue([]);
});

describe('verifyWitnessRecord — happy paths', () => {
  it('accepts a record signed by the current key on a node that has never rotated', async () => {
    const key = authCrypto.generateKeypair();
    h.getNodeSigningIdentity.mockReturnValue({ senderPubkey: key.publicKey });

    const result = await verifyWitnessRecord(record(key, BEFORE));

    expect(result).toEqual({ ok: true, publicKey: key.publicKey, retiredKey: false });
    expect(h.loadStoredRotationPayloads).toHaveBeenCalledWith(NODE_DID);
  });

  it('accepts a pre-rotation record signed by the old key, after the rotation, using the historical key', async () => {
    const { previous } = rotatedNode();

    const result = await verifyWitnessRecord(record(previous, BEFORE));

    expect(result).toEqual({ ok: true, publicKey: previous.publicKey, retiredKey: true });
  });

  it('accepts a post-rotation record signed by the new key', async () => {
    const { current } = rotatedNode();

    const result = await verifyWitnessRecord(record(current, AFTER));

    expect(result).toEqual({ ok: true, publicKey: current.publicKey, retiredKey: false });
  });

  it('accepts a matching vault-derived witnessDid', async () => {
    const { current } = rotatedNode();

    const result = await verifyWitnessRecord(record(current, AFTER, { witnessDid: `did:imajin:${current.publicKey.slice(0, 16)}` }));

    expect(result.ok).toBe(true);
  });

  it('accepts Date and epoch-millisecond timestamps', async () => {
    const { previous } = rotatedNode();

    expect((await verifyWitnessRecord(record(previous, BEFORE, { witnessedAt: new Date(BEFORE) }))).ok).toBe(true);
    expect((await verifyWitnessRecord(record(previous, BEFORE, { witnessedAt: Date.parse(BEFORE) }))).ok).toBe(true);
  });
});

describe('verifyWitnessRecord — fails closed', () => {
  it('rejects a retired key signing a record dated after the rotation (no forward use)', async () => {
    const { previous } = rotatedNode();

    const result = await verifyWitnessRecord(record(previous, AFTER));

    expect(result).toMatchObject({ ok: false, code: 'key-not-valid-at-time' });
  });

  it('rejects the rotation-instant boundary for the old key but accepts it for the new key', async () => {
    const { previous, current } = rotatedNode();
    const at = ROTATED_AT.toISOString();

    expect(await verifyWitnessRecord(record(previous, at))).toMatchObject({ ok: false, code: 'key-not-valid-at-time' });
    expect((await verifyWitnessRecord(record(current, at))).ok).toBe(true);
  });

  it('rejects a key the history has never seen', async () => {
    rotatedNode();
    const stranger = authCrypto.generateKeypair();

    const result = await verifyWitnessRecord(record(stranger, BEFORE));

    expect(result).toMatchObject({ ok: false, code: 'unknown-key' });
  });

  it('rejects an unknown key on a never-rotated node (an unattested rotation leaves old records unverifiable)', async () => {
    const current = authCrypto.generateKeypair();
    h.getNodeSigningIdentity.mockReturnValue({ senderPubkey: current.publicKey });

    const result = await verifyWitnessRecord(record(authCrypto.generateKeypair(), BEFORE));

    expect(result).toMatchObject({ ok: false, code: 'unknown-key' });
  });

  it('rejects when the chain is broken (a tampered rotation signature)', async () => {
    const { previous } = rotatedNode();
    const [good] = await h.loadStoredRotationPayloads();
    h.loadStoredRotationPayloads.mockResolvedValue([{ ...good, oldKeySignature: good.newKeySignature }]);

    const result = await verifyWitnessRecord(record(previous, BEFORE));

    expect(result).toMatchObject({ ok: false, code: 'history-broken' });
  });

  it('rejects when the chain forks', async () => {
    const { previous } = rotatedNode();
    const [good] = await h.loadStoredRotationPayloads();
    const rival = authCrypto.generateKeypair();
    const fork = createKeyRotatedPayload({ oldPrivateKey: previous.privateKey, newPrivateKey: rival.privateKey, effectiveAt: ROTATED_AT });
    h.loadStoredRotationPayloads.mockResolvedValue([good, fork]);

    const result = await verifyWitnessRecord(record(previous, BEFORE));

    expect(result).toMatchObject({ ok: false, code: 'history-broken' });
  });

  it('rejects when the chain has a gap (disconnected rotations)', async () => {
    const a = authCrypto.generateKeypair();
    const b = authCrypto.generateKeypair();
    const c = authCrypto.generateKeypair();
    const d = authCrypto.generateKeypair();
    h.loadStoredRotationPayloads.mockResolvedValue([
      createKeyRotatedPayload({ oldPrivateKey: a.privateKey, newPrivateKey: b.privateKey, effectiveAt: new Date('2026-03-01T00:00:00Z') }),
      createKeyRotatedPayload({ oldPrivateKey: c.privateKey, newPrivateKey: d.privateKey, effectiveAt: ROTATED_AT }),
    ]);
    h.getNodeSigningIdentity.mockReturnValue({ senderPubkey: d.publicKey });

    const result = await verifyWitnessRecord(record(a, '2026-01-01T00:00:00.000Z'));

    expect(result).toMatchObject({ ok: false, code: 'history-broken' });
  });

  it('rejects when the chain does not start at the pinned anchor', async () => {
    const { previous } = rotatedNode();

    const result = await verifyWitnessRecord(record(previous, BEFORE), { anchorPublicKey: authCrypto.generateKeypair().publicKey });

    expect(result).toMatchObject({ ok: false, code: 'history-broken' });
  });

  it('accepts a chain that starts at the pinned anchor', async () => {
    const { previous } = rotatedNode();

    const result = await verifyWitnessRecord(record(previous, BEFORE), { anchorPublicKey: previous.publicKey });

    expect(result.ok).toBe(true);
  });

  it('rejects when the history does not end at the key the node is signing with', async () => {
    const { previous } = rotatedNode();
    h.getNodeSigningIdentity.mockReturnValue({ senderPubkey: authCrypto.generateKeypair().publicKey });

    const result = await verifyWitnessRecord(record(previous, BEFORE));

    expect(result).toMatchObject({ ok: false, code: 'history-not-current' });
  });

  it('rejects a bad signature from a known, in-window key', async () => {
    const { previous } = rotatedNode();
    const other = authCrypto.generateKeypair();

    const forged = record(previous, BEFORE, { signature: authCrypto.signSync(MESSAGE, other.privateKey) });

    expect(await verifyWitnessRecord(forged)).toMatchObject({ ok: false, code: 'bad-signature' });
    expect(await verifyWitnessRecord(record(previous, BEFORE, { message: 'tampered' }))).toMatchObject({ ok: false, code: 'bad-signature' });
    expect(await verifyWitnessRecord(record(previous, BEFORE, { signature: 'zz' }))).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('rejects an unparseable timestamp before touching the history', async () => {
    const { current } = rotatedNode();

    const result = await verifyWitnessRecord(record(current, 'not a date'));

    expect(result).toMatchObject({ ok: false, code: 'invalid-timestamp' });
    expect(h.loadStoredRotationPayloads).not.toHaveBeenCalled();
  });

  it('rejects malformed records and a witnessDid that does not match the key', async () => {
    const { current } = rotatedNode();

    expect(await verifyWitnessRecord(record(current, AFTER, { senderPubkey: 'abc' }))).toMatchObject({ ok: false, code: 'invalid-record' });
    expect(await verifyWitnessRecord(record(current, AFTER, { signature: undefined }))).toMatchObject({ ok: false, code: 'invalid-record' });
    expect(await verifyWitnessRecord(record(current, AFTER, { witnessDid: 'did:imajin:0000000000000000' }))).toMatchObject({
      ok: false,
      code: 'did-mismatch',
    });
    expect(h.loadStoredRotationPayloads).not.toHaveBeenCalled();
  });

  it('rejects when the node DID is missing or is the RELAY_DID fallback', async () => {
    const { current } = rotatedNode();

    h.resolveNodeDid.mockResolvedValue({ did: '', source: 'none' });
    expect(await verifyWitnessRecord(record(current, AFTER))).toMatchObject({ ok: false, code: 'node-did-unavailable' });

    h.resolveNodeDid.mockResolvedValue({ did: 'did:imajin:relay-identity', source: 'RELAY_DID' });
    expect(await verifyWitnessRecord(record(current, AFTER))).toMatchObject({ ok: false, code: 'node-did-unavailable' });
    expect(h.loadStoredRotationPayloads).not.toHaveBeenCalled();
  });

  it('rejects instead of throwing when the history or the current key cannot be loaded', async () => {
    const { current } = rotatedNode();

    h.loadStoredRotationPayloads.mockRejectedValue(new Error('db down'));
    expect(await verifyWitnessRecord(record(current, AFTER))).toMatchObject({ ok: false, code: 'history-unavailable' });

    h.loadStoredRotationPayloads.mockResolvedValue([]);
    h.getNodeSigningIdentity.mockImplementation(() => {
      throw new Error('AUTH_PRIVATE_KEY is required in production');
    });
    expect(await verifyWitnessRecord(record(current, AFTER))).toMatchObject({ ok: false, code: 'history-unavailable' });
  });
});

describe('verifyOperatorApprovalWitnessRecord', () => {
  const payload = {
    proposalId: 'p1',
    source: 'system-agent',
    kind: 'system-agent:restart',
    decision: 'approve',
    decidedBy: 'did:imajin:operator',
    decidedAt: BEFORE,
    contentHash: 'sha256:abc',
  };

  function decision(signer: Keys, overrides: Record<string, unknown> = {}) {
    return { payload, signature: authCrypto.signSync(canonicalize(payload), signer.privateKey), senderPubkey: signer.publicKey, ...overrides };
  }

  it('verifies a stored decision against the key valid at payload.decidedAt', async () => {
    const { previous } = rotatedNode();

    expect(await verifyOperatorApprovalWitnessRecord(decision(previous))).toEqual({ ok: true, publicKey: previous.publicKey, retiredKey: true });
  });

  it('fails closed when the payload was altered after witnessing', async () => {
    const { previous } = rotatedNode();

    const altered = decision(previous, { payload: { ...payload, decision: 'reject' } });

    expect(await verifyOperatorApprovalWitnessRecord(altered)).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('fails closed when decidedAt is moved past the rotation (retired key cannot back-date forward)', async () => {
    const { previous } = rotatedNode();

    const moved = decision(previous, { payload: { ...payload, decidedAt: AFTER } });

    expect(await verifyOperatorApprovalWitnessRecord(moved)).toMatchObject({ ok: false });
  });

  it('fails closed on malformed stored decisions', async () => {
    const { previous } = rotatedNode();

    expect(await verifyOperatorApprovalWitnessRecord(null)).toMatchObject({ ok: false, code: 'invalid-record' });
    expect(await verifyOperatorApprovalWitnessRecord({ ...decision(previous), payload: 'x' })).toMatchObject({ ok: false, code: 'invalid-record' });
    expect(await verifyOperatorApprovalWitnessRecord({ ...decision(previous), payload: {} })).toMatchObject({ ok: false, code: 'invalid-timestamp' });
    expect(await verifyOperatorApprovalWitnessRecord({ ...decision(previous), signature: 1 })).toMatchObject({ ok: false, code: 'invalid-record' });
  });
});
