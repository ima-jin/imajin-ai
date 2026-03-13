import { randomBytes } from 'crypto';

/**
 * Short-lived WS auth tokens.
 * Token → DID mapping, expires after 30 seconds.
 */
const tokenStore = new Map<string, { did: string; expires: number }>();

// Clean up expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (entry.expires < now) tokenStore.delete(token);
  }
}, 60000);

export function createWsToken(did: string): string {
  const token = randomBytes(32).toString('hex');
  tokenStore.set(token, {
    did,
    expires: Date.now() + 30000, // 30 seconds
  });
  return token;
}

export function resolveWsToken(token: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  tokenStore.delete(token); // one-time use
  return entry.did;
}
