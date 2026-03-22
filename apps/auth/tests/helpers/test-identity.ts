import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import bs58 from 'bs58';

// Required for sync operations in @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ---- hex utils ----

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---- types ----

export type IdentityType = 'human' | 'agent' | 'presence' | 'org' | 'device' | 'service' | 'event';

export interface TestIdentity {
  /** Ed25519 private key (32 bytes, hex) */
  privateKey: string;
  /** Ed25519 public key (32 bytes, hex) */
  publicKey: string;
  /** did:imajin:{base58(publicKey)} */
  did: string;
  type: IdentityType;
  handle?: string;
  name?: string;

  /** Sign an arbitrary UTF-8 message, returns hex signature */
  sign(message: string): Promise<string>;

  /**
   * Build + sign the simple registration payload that the register route accepts.
   * Matches: JSON.stringify({ publicKey, handle, name, type })
   */
  registrationPayload(): Promise<{
    publicKey: string;
    handle?: string;
    name?: string;
    type: IdentityType;
    signature: string;
  }>;
}

// ---- factory ----

/**
 * Generate a fresh Ed25519 keypair and wrap it in a TestIdentity.
 *
 * @example
 * const alice = await createTestIdentity({ type: 'human', handle: 'alice' });
 * const body  = await alice.registrationPayload();
 * // POST /api/register with body
 */
export async function createTestIdentity(opts: {
  type?: IdentityType;
  handle?: string;
  name?: string;
} = {}): Promise<TestIdentity> {
  const { type = 'human', handle, name } = opts;

  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);

  const privateKey = bytesToHex(privateKeyBytes);
  const publicKey = bytesToHex(publicKeyBytes);
  const did = `did:imajin:${bs58.encode(publicKeyBytes)}`;

  async function sign(message: string): Promise<string> {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = await ed.signAsync(msgBytes, privateKeyBytes);
    return bytesToHex(sigBytes);
  }

  async function registrationPayload() {
    const payload = { publicKey, handle, name, type };
    const signature = await sign(JSON.stringify(payload));
    return { publicKey, handle, name, type, signature };
  }

  return { privateKey, publicKey, did, type, handle, name, sign, registrationPayload };
}

/**
 * Create multiple test identities at once.
 */
export async function createTestIdentities(
  count: number,
  opts: { type?: IdentityType } = {},
): Promise<TestIdentity[]> {
  return Promise.all(Array.from({ length: count }, () => createTestIdentity(opts)));
}
