'use client';

/**
 * Create a DFOS identity chain from a keypair.
 * Runs in the browser — private key never leaves.
 *
 * Returns the chain payload to send to the server, or null on failure.
 */
export async function createDfosChain(keypair: {
  privateKey: string;
  publicKey: string;
}): Promise<{
  did: string;
  log: string[];
  operationCID: string;
} | null> {
  try {
    const { createIdentityChain } = await import('@imajin/dfos');
    return await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });
  } catch (err) {
    console.error('[dfos] Client chain creation failed:', err);
    return null;
  }
}
