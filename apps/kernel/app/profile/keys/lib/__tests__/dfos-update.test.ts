/**
 * buildSignedUpdate's signer (#2564): `signPayloadEd25519` is synchronous, so the
 * signer handed to `signIdentityOperation` is a plain function returning a
 * Promise. These tests pin that Promise contract, including that a sync throw
 * while signing still surfaces as a rejection (what `async` used to guarantee).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const protocol = vi.hoisted(() => ({
  importEd25519Keypair: vi.fn(),
  signPayloadEd25519: vi.fn(),
  signIdentityOperation: vi.fn(),
  verifyIdentityChain: vi.fn(),
}));

vi.mock('@metalabel/dfos-protocol', () => protocol);

import { buildSignedUpdate, hexToBytes, bytesToHex } from '../dfos-update';

const input = {
  controllerPrivateKeyHex: '0a0b0c',
  dfosDid: 'did:dfos:abc',
  signingKeyId: 'key-1',
  existingLog: ['jws-0'],
  headCid: 'bafy-head',
  newKeys: {
    authKeys: [{ id: 'a', publicKeyMultibase: 'zA' }],
    assertKeys: [{ id: 'b', publicKeyMultibase: 'zB' }],
    controllerKeys: [{ id: 'c', publicKeyMultibase: 'zC' }],
  },
};

const privateKey = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  protocol.importEd25519Keypair.mockReturnValue({ privateKey });
  protocol.verifyIdentityChain.mockResolvedValue({});
  protocol.signIdentityOperation.mockImplementation(async ({ signer }: { signer: (m: Uint8Array) => Promise<Uint8Array> }) => {
    await signer(new Uint8Array([9]));
    return { jwsToken: 'jws-1', operationCID: 'cid-1' };
  });
});

describe('buildSignedUpdate signer', () => {
  it('hands signIdentityOperation a signer that returns a Promise resolving to the signature', async () => {
    const signature = new Uint8Array([4, 5, 6]);
    protocol.signPayloadEd25519.mockReturnValue(signature);
    let captured: ((m: Uint8Array) => Promise<Uint8Array>) | undefined;
    protocol.signIdentityOperation.mockImplementation(async ({ signer }) => {
      captured = signer;
      return { jwsToken: 'jws-1', operationCID: 'cid-1' };
    });

    await buildSignedUpdate(input);

    const pending = captured!(new Uint8Array([9]));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe(signature);
    expect(protocol.signPayloadEd25519).toHaveBeenCalledWith(new Uint8Array([9]), privateKey);
  });

  it('turns a synchronous signing throw into a rejected promise', async () => {
    protocol.signPayloadEd25519.mockImplementation(() => {
      throw new Error('bad key');
    });
    let captured: ((m: Uint8Array) => Promise<Uint8Array>) | undefined;
    protocol.signIdentityOperation.mockImplementation(async ({ signer }) => {
      captured = signer;
      return { jwsToken: 'jws-1', operationCID: 'cid-1' };
    });

    await buildSignedUpdate(input);

    let pending: Promise<Uint8Array> | undefined;
    expect(() => {
      pending = captured!(new Uint8Array([9]));
    }).not.toThrow();
    await expect(pending).rejects.toThrow('bad key');
  });

  it('propagates a signing failure out of buildSignedUpdate', async () => {
    protocol.signPayloadEd25519.mockImplementation(() => {
      throw new Error('bad key');
    });

    await expect(buildSignedUpdate(input)).rejects.toThrow('bad key');
    expect(protocol.verifyIdentityChain).not.toHaveBeenCalled();
  });

  it('appends the signed op to the log and verifies the updated chain', async () => {
    protocol.signPayloadEd25519.mockReturnValue(new Uint8Array([4]));

    const result = await buildSignedUpdate(input);

    expect(result).toEqual({ log: ['jws-0', 'jws-1'], operationCID: 'cid-1' });
    expect(protocol.importEd25519Keypair).toHaveBeenCalledWith(hexToBytes(input.controllerPrivateKeyHex));
    expect(protocol.verifyIdentityChain).toHaveBeenCalledWith({ didPrefix: 'did:dfos', log: ['jws-0', 'jws-1'] });
  });
});

describe('hex helpers', () => {
  it('round-trips bytes through hex', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
  });
});
