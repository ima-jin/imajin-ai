import {
  canonicalReachReply,
  type ReachReplyEvent,
  type ReachReplySignature,
} from '@/src/lib/auth/reach-reply-wire';

const INVALID_KEY = 'Invalid browser signing key. Import your own Ed25519 key in this browser before replying.';
const PKCS8_PREFIX = '302e020100300506032b657004220420';

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], part => Number.parseInt(part, 16));
}

function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function readKeypair(): { privateKey: string; publicKey: string } {
  const stored = globalThis.localStorage.getItem('imajin_keypair');
  if (!stored) throw new Error('No browser signing key. Sign in with or import your own key before replying.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error(INVALID_KEY);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(INVALID_KEY);
  const pair = parsed as Record<string, unknown>;
  if (typeof pair.privateKey !== 'string' || typeof pair.publicKey !== 'string') {
    throw new TypeError(INVALID_KEY);
  }
  const privateKey = pair.privateKey.toLowerCase().trim();
  const publicKey = pair.publicKey.toLowerCase().trim();
  const seed = privateKey.startsWith(PKCS8_PREFIX) ? privateKey.slice(PKCS8_PREFIX.length) : privateKey;
  if (!/^[0-9a-f]{64}$/.test(seed) || !/^[0-9a-f]{64}$/.test(publicKey)) throw new Error(INVALID_KEY);
  return { privateKey: seed, publicKey };
}

/** No node key, delegated signer, or unsigned fallback is ever used. */
export async function signReachReply(event: ReachReplyEvent): Promise<ReachReplySignature> {
  const pair = readKeypair();
  const { ed25519 } = await import('@noble/curves/ed25519');
  const seed = hexBytes(pair.privateKey);
  if (bytesHex(ed25519.getPublicKey(seed)) !== pair.publicKey) throw new Error(INVALID_KEY);
  const sig = bytesHex(ed25519.sign(new TextEncoder().encode(canonicalReachReply(event)), seed));
  return { keyId: pair.publicKey, alg: 'ed25519', sig };
}
