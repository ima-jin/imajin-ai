import { describe, expect, it } from 'vitest';
import { createIdentityChain, verifyChain } from '@imajin/dfos';
import { buildSignedUpdate, generateKeypair, hexToMultikey } from '../dfos-update';

describe('profile key rotation with protocol 0.55', () => {
  it('proves a fresh replacement key in every requested role while preserving the DID', async () => {
    const oldKey = await generateKeypair();
    const genesis = await createIdentityChain(oldKey);
    const prior = await verifyChain(genesis.log);
    const replacement = await generateKeypair();
    const multibase = await hexToMultikey(replacement.publicKeyHex);
    const keys = [{ id: replacement.keyId, publicKeyMultibase: multibase }];
    const updated = await buildSignedUpdate({
      controllerPrivateKeyHex: oldKey.privateKeyHex, newKeyPrivateKeyHex: replacement.privateKeyHex,
      dfosDid: genesis.did, signingKeyId: prior.controllerKeys[0].id, headCid: genesis.operationCID,
      existingLog: genesis.log, newKeys: { authKeys: keys, assertKeys: keys, controllerKeys: keys },
    });
    const verified = await verifyChain(updated.log);
    expect(verified.did).toBe(genesis.did);
    expect(verified.voidKeys).toEqual([]);
    for (const role of ['authKeys', 'assertKeys', 'controllerKeys'] as const) {
      expect(verified[role]).toEqual([{ ...keys[0], type: 'Multikey' }]);
    }
    expect(replacement.keyId).not.toBe(prior.controllerKeys[0].id);
  });

  it('does not sign a possession envelope for a key absent from the requested roles', async () => {
    const oldKey = await generateKeypair();
    const genesis = await createIdentityChain(oldKey);
    const prior = await verifyChain(genesis.log);
    const stranger = await generateKeypair();
    await expect(buildSignedUpdate({
      controllerPrivateKeyHex: oldKey.privateKeyHex, newKeyPrivateKeyHex: stranger.privateKeyHex,
      dfosDid: genesis.did, signingKeyId: prior.controllerKeys[0].id, headCid: genesis.operationCID,
      existingLog: genesis.log, newKeys: prior,
    })).rejects.toThrow('not declared');
  });

  it('continues to support removal-only updates without a new key or possession envelope', async () => {
    const oldKey = await generateKeypair();
    const genesis = await createIdentityChain(oldKey);
    const prior = await verifyChain(genesis.log);
    const updated = await buildSignedUpdate({
      controllerPrivateKeyHex: oldKey.privateKeyHex, dfosDid: genesis.did,
      signingKeyId: prior.controllerKeys[0].id, headCid: genesis.operationCID,
      existingLog: genesis.log, newKeys: { ...prior, assertKeys: [] },
    });
    const verified = await verifyChain(updated.log);
    expect(verified.assertKeys).toEqual([]);
    expect(verified.controllerKeys).toEqual(prior.controllerKeys);
    expect(verified.voidKeys).toEqual([]);
  });
});
