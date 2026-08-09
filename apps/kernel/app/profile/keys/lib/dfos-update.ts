'use client';

/**
 * Client-side helpers for reading and updating a DFOS identity chain
 * (key rotation, device revocation).
 *
 * Everything here runs in the browser — private key material never leaves
 * the device. All the heavy DAG-CBOR/Ed25519 machinery is loaded from
 * `@metalabel/dfos-protocol` via dynamic `import()` (matching the existing
 * `src/lib/auth/dfos-client.ts` pattern) so it's code-split into its own
 * chunk. We deliberately import `@metalabel/dfos-protocol` directly instead
 * of the `@imajin/dfos` workspace wrapper, since that wrapper's barrel file
 * pulls in `@imajin/auth` (which re-exports server-only modules backed by
 * `@imajin/db` / `next/server`) — unsafe to bundle into client code.
 */

const DFOS_DID_PREFIX = 'did:dfos';

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MultikeyEntry {
  id: string;
  publicKeyMultibase: string;
}

export interface VerifiedChainState {
  did: string;
  isDeleted: boolean;
  authKeys: MultikeyEntry[];
  assertKeys: MultikeyEntry[];
  controllerKeys: MultikeyEntry[];
}

/** Convert a hex-encoded Ed25519 public key to a W3C Multikey multibase string. */
export async function hexToMultikey(publicKeyHex: string): Promise<string> {
  const { encodeEd25519Multikey } = await import('@metalabel/dfos-protocol');
  return encodeEd25519Multikey(hexToBytes(publicKeyHex));
}

/** Verify a DFOS identity chain log locally and return its resolved state. */
export async function verifyChainClient(log: string[]): Promise<VerifiedChainState> {
  const { verifyIdentityChain } = await import('@metalabel/dfos-protocol');
  const verified = await verifyIdentityChain({ didPrefix: DFOS_DID_PREFIX, log });
  return verified as unknown as VerifiedChainState;
}

/** Generate a brand-new Ed25519 keypair (hex-encoded) for a rotated/new device key. */
export async function generateKeypair(): Promise<{ privateKeyHex: string; publicKeyHex: string }> {
  const { createNewEd25519Keypair } = await import('@metalabel/dfos-protocol');
  const { privateKey, publicKey } = createNewEd25519Keypair();
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

/**
 * Build and sign a DFOS identity-chain UPDATE operation.
 *
 * Must be signed by a CURRENT controller key (`controllerPrivateKeyHex` /
 * `signingKeyId`). This is a FULL REPLACEMENT of all three role arrays, not
 * an additive patch — callers must pass every key that should remain after
 * the update (unchanged keys included), matching DFOS update semantics.
 */
export async function buildSignedUpdate(input: {
  controllerPrivateKeyHex: string;
  dfosDid: string;
  signingKeyId: string;
  existingLog: string[];
  headCid: string;
  newKeys: {
    authKeys: MultikeyEntry[];
    assertKeys: MultikeyEntry[];
    controllerKeys: MultikeyEntry[];
  };
}): Promise<{ log: string[]; operationCID: string }> {
  const { signIdentityOperation, verifyIdentityChain, importEd25519Keypair, signPayloadEd25519 } =
    await import('@metalabel/dfos-protocol');

  const toOperationKeys = (keys: MultikeyEntry[]) =>
    keys.map((k) => ({ id: k.id, type: 'Multikey' as const, publicKeyMultibase: k.publicKeyMultibase }));

  const operation = {
    version: 1 as const,
    type: 'update' as const,
    previousOperationCID: input.headCid,
    authKeys: toOperationKeys(input.newKeys.authKeys),
    assertKeys: toOperationKeys(input.newKeys.assertKeys),
    controllerKeys: toOperationKeys(input.newKeys.controllerKeys),
    createdAt: new Date().toISOString(),
  };

  const { privateKey } = importEd25519Keypair(hexToBytes(input.controllerPrivateKeyHex));
  const signer = async (message: Uint8Array) => signPayloadEd25519(message, privateKey);

  const { jwsToken, operationCID } = await signIdentityOperation({
    operation,
    signer,
    keyId: input.signingKeyId,
    identityDID: input.dfosDid,
  });

  const updatedLog = [...input.existingLog, jwsToken];

  // Validate the update locally before ever sending it to the server, so
  // obvious mistakes surface immediately instead of as an opaque 400.
  await verifyIdentityChain({ didPrefix: DFOS_DID_PREFIX, log: updatedLog });

  return { log: updatedLog, operationCID };
}
