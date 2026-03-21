import { describe, it, expect } from 'vitest';
import { createIdentityChain, updateIdentityChain, verifyChain } from '../src/bridge';
import { getPublicKeyBytes } from '../src/signer';
import { encodeEd25519Multikey } from '@metalabel/dfos-protocol';
import { bytesToHex, hexToBytes } from '@imajin/auth';
import { ed25519 } from '@noble/curves/ed25519';

/** Generate a random Ed25519 keypair as hex strings */
function generateKeypair() {
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  return {
    privateKeyHex: bytesToHex(privateKeyBytes),
    publicKeyHex: bytesToHex(publicKeyBytes),
  };
}

describe('key rotation via updateIdentityChain', () => {
  it('rotates to a new controller key', async () => {
    // Genesis with K1
    const k1 = generateKeypair();
    const genesis = await createIdentityChain(k1);
    expect(genesis.log).toHaveLength(1);

    // Verify genesis
    const beforeRotation = await verifyChain(genesis.log);
    expect(beforeRotation.controllerKeys).toHaveLength(1);

    // Get K1's key ID from the verified chain
    const k1KeyId = beforeRotation.controllerKeys[0].id;

    // Generate K2 (new key)
    const k2 = generateKeypair();
    const k2KeyId = `key_newcontroller`;

    // Rotate: K1 → K2 in all roles
    const updated = await updateIdentityChain({
      controllerPrivateKeyHex: k1.privateKeyHex,
      did: genesis.did,
      signingKeyId: k1KeyId,
      existingLog: genesis.log,
      headCid: genesis.operationCID,
      newKeys: {
        authKeys: [{ id: k2KeyId, publicKeyHex: k2.publicKeyHex }],
        assertKeys: [{ id: k2KeyId, publicKeyHex: k2.publicKeyHex }],
        controllerKeys: [{ id: k2KeyId, publicKeyHex: k2.publicKeyHex }],
      },
    });

    expect(updated.log).toHaveLength(2);
    expect(updated.operationCID).toBeTruthy();

    // Verify the updated chain
    const afterRotation = await verifyChain(updated.log);
    expect(afterRotation.isDeleted).toBe(false);
    expect(afterRotation.controllerKeys).toHaveLength(1);

    // New key should be the controller
    const k2Multibase = encodeEd25519Multikey(hexToBytes(k2.publicKeyHex));
    expect(afterRotation.controllerKeys[0].publicKeyMultibase).toBe(k2Multibase);

    // K1 should no longer be in any role
    const k1Multibase = encodeEd25519Multikey(hexToBytes(k1.publicKeyHex));
    expect(afterRotation.authKeys.find(k => k.publicKeyMultibase === k1Multibase)).toBeUndefined();
    expect(afterRotation.assertKeys.find(k => k.publicKeyMultibase === k1Multibase)).toBeUndefined();
    expect(afterRotation.controllerKeys.find(k => k.publicKeyMultibase === k1Multibase)).toBeUndefined();
  });

  it('DID is preserved after rotation', async () => {
    const k1 = generateKeypair();
    const genesis = await createIdentityChain(k1);
    const k1KeyId = (await verifyChain(genesis.log)).controllerKeys[0].id;

    const k2 = generateKeypair();
    const updated = await updateIdentityChain({
      controllerPrivateKeyHex: k1.privateKeyHex,
      did: genesis.did,
      signingKeyId: k1KeyId,
      existingLog: genesis.log,
      headCid: genesis.operationCID,
      newKeys: {
        authKeys: [{ id: 'key_k2', publicKeyHex: k2.publicKeyHex }],
        assertKeys: [{ id: 'key_k2', publicKeyHex: k2.publicKeyHex }],
        controllerKeys: [{ id: 'key_k2', publicKeyHex: k2.publicKeyHex }],
      },
    });

    const afterRotation = await verifyChain(updated.log);
    expect(afterRotation.did).toBe(genesis.did);
  });

  it('rejects update signed by non-controller key', async () => {
    const k1 = generateKeypair();
    const genesis = await createIdentityChain(k1);

    // Random key that isn't the controller
    const rogue = generateKeypair();

    await expect(
      updateIdentityChain({
        controllerPrivateKeyHex: rogue.privateKeyHex,
        did: genesis.did,
        signingKeyId: 'key_rogue',
        existingLog: genesis.log,
        headCid: genesis.operationCID,
        newKeys: {
          authKeys: [{ id: 'key_rogue', publicKeyHex: rogue.publicKeyHex }],
          assertKeys: [{ id: 'key_rogue', publicKeyHex: rogue.publicKeyHex }],
          controllerKeys: [{ id: 'key_rogue', publicKeyHex: rogue.publicKeyHex }],
        },
      })
    ).rejects.toThrow();
  });
});

describe('role separation', () => {
  it('adds a second auth key while keeping single controller', async () => {
    const k1 = generateKeypair();
    const genesis = await createIdentityChain(k1);
    const k1KeyId = (await verifyChain(genesis.log)).controllerKeys[0].id;

    const k2 = generateKeypair();

    // Update: authKeys=[K1, K2], assertKeys=[K1], controllerKeys=[K1]
    const updated = await updateIdentityChain({
      controllerPrivateKeyHex: k1.privateKeyHex,
      did: genesis.did,
      signingKeyId: k1KeyId,
      existingLog: genesis.log,
      headCid: genesis.operationCID,
      newKeys: {
        authKeys: [
          { id: k1KeyId, publicKeyHex: k1.publicKeyHex },
          { id: 'key_device2', publicKeyHex: k2.publicKeyHex },
        ],
        assertKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
        controllerKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
      },
    });

    const verified = await verifyChain(updated.log);
    expect(verified.authKeys).toHaveLength(2);
    expect(verified.assertKeys).toHaveLength(1);
    expect(verified.controllerKeys).toHaveLength(1);
  });

  it('supports multiple rotations in sequence', async () => {
    const k1 = generateKeypair();
    const genesis = await createIdentityChain(k1);
    const k1KeyId = (await verifyChain(genesis.log)).controllerKeys[0].id;

    // First rotation: add K2 as auth
    const k2 = generateKeypair();
    const update1 = await updateIdentityChain({
      controllerPrivateKeyHex: k1.privateKeyHex,
      did: genesis.did,
      signingKeyId: k1KeyId,
      existingLog: genesis.log,
      headCid: genesis.operationCID,
      newKeys: {
        authKeys: [
          { id: k1KeyId, publicKeyHex: k1.publicKeyHex },
          { id: 'key_k2', publicKeyHex: k2.publicKeyHex },
        ],
        assertKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
        controllerKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
      },
    });

    // Second rotation: remove K2, add K3
    const k3 = generateKeypair();
    const update2 = await updateIdentityChain({
      controllerPrivateKeyHex: k1.privateKeyHex,
      did: genesis.did,
      signingKeyId: k1KeyId,
      existingLog: update1.log,
      headCid: update1.operationCID,
      newKeys: {
        authKeys: [
          { id: k1KeyId, publicKeyHex: k1.publicKeyHex },
          { id: 'key_k3', publicKeyHex: k3.publicKeyHex },
        ],
        assertKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
        controllerKeys: [{ id: k1KeyId, publicKeyHex: k1.publicKeyHex }],
      },
    });

    expect(update2.log).toHaveLength(3); // genesis + 2 updates
    const verified = await verifyChain(update2.log);
    expect(verified.authKeys).toHaveLength(2);

    // K2 should be gone, K3 should be present
    const k2Multibase = encodeEd25519Multikey(hexToBytes(k2.publicKeyHex));
    const k3Multibase = encodeEd25519Multikey(hexToBytes(k3.publicKeyHex));
    expect(verified.authKeys.find(k => k.publicKeyMultibase === k2Multibase)).toBeUndefined();
    expect(verified.authKeys.find(k => k.publicKeyMultibase === k3Multibase)).toBeTruthy();
  });
});
