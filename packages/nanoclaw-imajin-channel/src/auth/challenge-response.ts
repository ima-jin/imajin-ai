/**
 * Ed25519 challenge-response authentication against the Imajin kernel.
 *
 * Ported pattern (imajin-ai#1932 step 0 research), not a shared dependency:
 * `openclaw-imajin-plugin/src/ws-service.ts`'s `authenticate()` is the
 * reference implementation for "speak to the kernel as an agent" — that repo
 * is a separate OpenClaw plugin package, not importable here, so this module
 * re-implements the same two-step protocol against this package's own
 * agent DID + keypair:
 *
 *   1. `POST /auth/api/login/challenge` `{ did }` -> `{ challengeId, challenge }`
 *   2. sign `challenge` with the agent's Ed25519 private key
 *   3. `POST /auth/api/login/verify` `{ challengeId, signature }` -> session cookie
 */
import { crypto } from '@imajin/auth';
import { stripTrailingSlashes } from '../url-utils.js';

export interface ChallengeResponseConfig {
  kernelBaseUrl: string;
  did: string;
  privateKeyHex: string;
}

export interface AuthenticatedSession {
  /** The `name=value` session cookie pair to send on subsequent requests. */
  cookie: string;
}

interface ChallengeResponse {
  challengeId: string;
  challenge: string;
}

async function requestChallenge(config: ChallengeResponseConfig, fetchImpl: typeof fetch): Promise<ChallengeResponse> {
  const res = await fetchImpl(`${stripTrailingSlashes(config.kernelBaseUrl)}/auth/api/login/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: config.did }),
  });
  if (!res.ok) {
    throw new Error(`Auth challenge failed (${res.status})`);
  }
  return (await res.json()) as ChallengeResponse;
}

/**
 * Extract the `name=value` pair from a `Set-Cookie` response header, without
 * a regex: split on the first `;` to drop attributes (`Path=`, `HttpOnly`,
 * ...), then confirm what remains has a `name=value` shape.
 */
export function parseSessionCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) {
    throw new Error('Auth verify: no session cookie in response');
  }
  const firstPair = setCookieHeader.split(';', 1)[0]?.trim() ?? '';
  const eq = firstPair.indexOf('=');
  if (eq <= 0) {
    throw new Error('Auth verify: could not parse session cookie');
  }
  return firstPair;
}

/**
 * Run the full challenge-response flow and return an authenticated session
 * cookie. `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function authenticate(
  config: ChallengeResponseConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthenticatedSession> {
  const { challengeId, challenge } = await requestChallenge(config, fetchImpl);
  const signature = crypto.signSync(challenge, config.privateKeyHex);

  const verifyRes = await fetchImpl(`${stripTrailingSlashes(config.kernelBaseUrl)}/auth/api/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, signature }),
  });
  if (!verifyRes.ok) {
    throw new Error(`Auth verify failed (${verifyRes.status})`);
  }

  const cookie = parseSessionCookie(verifyRes.headers.get('set-cookie'));
  return { cookie };
}
