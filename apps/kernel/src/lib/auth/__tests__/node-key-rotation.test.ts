/**
 * Tests for the kernel side of node key rotation (#2081): recording the
 * operator-signed `key.rotated` attestation and verifying the stored history.
 * The pure crypto is covered in packages/auth/tests/key-rotation.test.ts;
 * these tests use the real @imajin/auth with only the DB, node DID and the
 * mechanical-attestation writer faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKeyRotatedPayload,
  computeKeyKid,
  crypto as authCrypto,
  verifyKeyRotatedPayload,
} from '@imajin/auth';

const h = vi.hoisted(() => ({
  attestationRows: vi.fn(),
  identityRows: vi.fn(),
  getNodeDid: vi.fn(),
  emitMechanicalAttestation: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => h.attestationRows(),
          limit: () => h.identityRows(),
        }),
      }),
    }),
  },
  attestations: {},
  identities: {},
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: h.getNodeDid }));
vi.mock('../emit-mechanical-attestation', () => ({ emitMechanicalAttestation: h.emitMechanicalAttestation }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { recordKeyRotation, verifyNodeKeyHistory } from '../node-key-rotation';

const NODE_DID = 'did:imajin:test-node';
const ORIGINAL_KEY = process.env.AUTH_PRIVATE_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  h.getNodeDid.mockResolvedValue(NODE_DID);
  h.emitMechanicalAttestation.mockResolvedValue('att_rotated_1');
  h.attestationRows.mockResolvedValue([]);
  h.identityRows.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.AUTH_PRIVATE_KEY;
  else process.env.AUTH_PRIVATE_KEY = ORIGINAL_KEY;
});

describe('recordKeyRotation', () => {
  const NOW = new Date('2026-10-06T12:30:00.000Z');
  const EFFECTIVE = new Date('2026-10-06T12:00:00.000Z');

  /** The operator's offline `sign` step, then the swap: the kernel now runs with the NEW key. */
  function swapped() {
    const oldKey = authCrypto.generateKeypair();
    const newKey = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = newKey.privateKey;
    const payload = createKeyRotatedPayload({
      oldPrivateKey: oldKey.privateKey,
      newPrivateKey: newKey.privateKey,
      effectiveAt: EFFECTIVE,
    });
    return { oldKey, newKey, payload };
  }

  it('files a node-issued key.rotated carrying exactly the submitted dual-signed payload', async () => {
    const { oldKey, newKey, payload } = swapped();

    const result = await recordKeyRotation(payload, NOW);

    expect(result).toEqual({
      ok: true,
      attestationId: 'att_rotated_1',
      oldKid: computeKeyKid(oldKey.publicKey),
      newKid: computeKeyKid(newKey.publicKey),
      effectiveAt: '2026-10-06T12:00:00.000Z',
    });
    const args = h.emitMechanicalAttestation.mock.calls[0][0];
    expect(args).toMatchObject({
      subjectDid: NODE_DID,
      type: 'key.rotated',
      contextId: computeKeyKid(newKey.publicKey),
      contextType: 'node.key',
      payload,
    });
    expect(verifyKeyRotatedPayload(args.payload).ok).toBe(true);
  });

  it('extends an existing history', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    const k2 = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = k2.privateKey;
    h.attestationRows.mockResolvedValue([
      { payload: createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey, effectiveAt: new Date('2026-03-01T00:00:00Z') }) },
    ]);
    const next = createKeyRotatedPayload({ oldPrivateKey: k1.privateKey, newPrivateKey: k2.privateKey, effectiveAt: EFFECTIVE });

    const result = await recordKeyRotation(next, NOW);

    expect(result.ok).toBe(true);
  });

  it('rejects a payload that is not fully dual-signed (400) before touching the node', async () => {
    const { payload } = swapped();

    const result = await recordKeyRotation({ ...payload, oldKeySignature: payload.newKeySignature }, NOW);

    expect(result).toEqual({ ok: false, status: 400, error: 'oldKeySignature does not verify against the old public key' });
    expect(h.emitMechanicalAttestation).not.toHaveBeenCalled();
    expect(h.getNodeDid).not.toHaveBeenCalled();
  });

  it('rejects garbage input', async () => {
    expect(await recordKeyRotation('nope', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await recordKeyRotation(undefined, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a rotation whose new key is not the key the node is signing with (swap not done yet)', async () => {
    const { payload } = swapped();
    process.env.AUTH_PRIVATE_KEY = authCrypto.generateKeypair().privateKey;

    const result = await recordKeyRotation(payload, NOW);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/swap AUTH_PRIVATE_KEY and restart/);
    expect(h.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('fails with 500 when AUTH_PRIVATE_KEY is unset', async () => {
    const { payload } = swapped();
    delete process.env.AUTH_PRIVATE_KEY;

    expect(await recordKeyRotation(payload, NOW)).toMatchObject({ ok: false, status: 500 });
  });

  it('rejects an effectiveAt in the future', async () => {
    const { payload } = swapped();

    const result = await recordKeyRotation(payload, new Date('2026-10-06T11:00:00.000Z'));

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/in the future/);
  });

  it('allows a small clock skew on effectiveAt', async () => {
    const { payload } = swapped();

    const result = await recordKeyRotation(payload, new Date('2026-10-06T11:57:00.000Z'));

    expect(result.ok).toBe(true);
  });

  it('fails with 500 when the node has no DID', async () => {
    const { payload } = swapped();
    h.getNodeDid.mockResolvedValue('');

    expect(await recordKeyRotation(payload, NOW)).toMatchObject({ ok: false, status: 500 });
    expect(h.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('refuses to record the same rotation twice (409)', async () => {
    const { payload } = swapped();
    h.attestationRows.mockResolvedValue([{ payload }]);

    const result = await recordKeyRotation(payload, NOW);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/already part of the recorded key history/);
    expect(h.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('refuses a rotation that forks the recorded history (409)', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    const rival = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = rival.privateKey;
    h.attestationRows.mockResolvedValue([
      { payload: createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey, effectiveAt: new Date('2026-03-01T00:00:00Z') }) },
    ]);
    // Rotates away from k0 again — k0 already has a successor (k1).
    const fork = createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: rival.privateKey, effectiveAt: EFFECTIVE });

    const result = await recordKeyRotation(fork, NOW);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/does not extend the recorded key history/);
  });

  it('refuses to extend a corrupt recorded history (409)', async () => {
    const { payload } = swapped();
    h.attestationRows.mockResolvedValue([{ payload: { not: 'a rotation' } }]);

    const result = await recordKeyRotation(payload, NOW);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/recorded key history is invalid/);
  });

  it('reports a failed write as a 500 rather than skipping silently', async () => {
    const { payload } = swapped();
    h.emitMechanicalAttestation.mockResolvedValue(null);

    const result = await recordKeyRotation(payload, NOW);

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toMatch(/could not be written/);
  });
});

describe('verifyNodeKeyHistory', () => {
  it('passes on a never-rotated node whose key matches the identity row, with a warning', async () => {
    const key = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = key.privateKey;
    h.identityRows.mockResolvedValue([{ publicKey: key.publicKey }]);

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(true);
    expect(report.rotations).toBe(0);
    expect(report.history).toEqual([]);
    expect(report.currentKid).toBe(computeKeyKid(key.publicKey));
    expect(report.warnings.join('\n')).toMatch(/no key.rotated attestation recorded/);
  });

  it('passes when the stored chain ends at the loaded key', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    const k2 = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = k2.privateKey;
    h.attestationRows.mockResolvedValue([
      { payload: createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey, effectiveAt: new Date('2026-03-01T00:00:00Z') }) },
      { payload: createKeyRotatedPayload({ oldPrivateKey: k1.privateKey, newPrivateKey: k2.privateKey, effectiveAt: new Date('2026-09-01T00:00:00Z') }) },
    ]);
    h.identityRows.mockResolvedValue([{ publicKey: k2.publicKey }]);

    const report = await verifyNodeKeyHistory({ anchorPublicKey: k0.publicKey });

    expect(report).toMatchObject({ ok: true, errors: [], warnings: [], rotations: 2, nodeDid: NODE_DID });
    expect(report.history.map((entry) => entry.publicKey)).toEqual([k0.publicKey, k1.publicKey, k2.publicKey]);
  });

  it('fails when the loaded key was never attested (swap without key.rotated)', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    const unattested = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = unattested.privateKey;
    h.attestationRows.mockResolvedValue([
      { payload: createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey }) },
    ]);
    h.identityRows.mockResolvedValue([{ publicKey: unattested.publicKey }]);

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/rotation was not attested/);
  });

  it('fails on a tampered chain and returns no history', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = k1.privateKey;
    const good = createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey });
    h.attestationRows.mockResolvedValue([{ payload: { ...good, oldKeySignature: good.newKeySignature } }]);

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(false);
    expect(report.history).toEqual([]);
    expect(report.errors.join('\n')).toMatch(/key history invalid/);
  });

  it('fails when the chain does not start at the pinned anchor', async () => {
    const k0 = authCrypto.generateKeypair();
    const k1 = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = k1.privateKey;
    h.attestationRows.mockResolvedValue([
      { payload: createKeyRotatedPayload({ oldPrivateKey: k0.privateKey, newPrivateKey: k1.privateKey }) },
    ]);

    const report = await verifyNodeKeyHistory({ anchorPublicKey: authCrypto.generateKeypair().publicKey });

    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/pinned anchor/);
  });

  it('fails when the node identity row holds a different key than AUTH_PRIVATE_KEY', async () => {
    const key = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = key.privateKey;
    h.identityRows.mockResolvedValue([{ publicKey: authCrypto.generateKeypair().publicKey }]);

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/identities\.public_key/);
  });

  it('warns (does not fail) when the node has no identity row', async () => {
    process.env.AUTH_PRIVATE_KEY = authCrypto.generateKeypair().privateKey;

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/no identities row/);
  });

  it('fails when AUTH_PRIVATE_KEY is unset or invalid', async () => {
    delete process.env.AUTH_PRIVATE_KEY;
    expect((await verifyNodeKeyHistory()).ok).toBe(false);

    process.env.AUTH_PRIVATE_KEY = 'garbage';
    const report = await verifyNodeKeyHistory();
    expect(report.ok).toBe(false);
    expect(report.currentKid).toBeNull();
  });

  it('fails without querying history when the node has no DID', async () => {
    process.env.AUTH_PRIVATE_KEY = authCrypto.generateKeypair().privateKey;
    h.getNodeDid.mockResolvedValue('');

    const report = await verifyNodeKeyHistory();

    expect(report.ok).toBe(false);
    expect(report.nodeDid).toBeNull();
    expect(h.attestationRows).not.toHaveBeenCalled();
  });
});
