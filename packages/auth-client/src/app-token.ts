/**
 * Session-scoped app token client (#1069 Phase 1, #2394).
 *
 * A federated app ("Sign in with Imajin") that needs to authenticate its
 * OWN backend calls to the kernel — e.g. submitting a delegated attestation
 * via `@imajin/auth`'s `submitDelegatedAttestation` (Ryan's 2026-09-26
 * ruling, #2394) — mints a short-lived, host-scoped token from the
 * currently signed-in user's kernel session via
 * `POST {authUrl}/auth/api/tokens/app`, then presents it back to the
 * kernel as `Authorization: Bearer <token>`.
 *
 * This helper only performs the mint call; it does not establish the
 * kernel session itself. The fetch must run somewhere the user's kernel
 * session is already in scope (same-origin, or `credentials: 'include'`
 * against a shared-cookie kernel domain).
 */

export interface RequestAppTokenOptions {
  /** The kernel's own base URL, e.g. https://jin.imajin.ai */
  authUrl: string;
  /** This app's own host — the audience the minted token is scoped to. */
  aud: string;
  /** Requested scopes, clamped server-side to the SCOPES vocabulary. */
  scopes?: string[];
  /** Extra fetch options (e.g. `credentials: 'include'`), merged under the defaults. */
  fetchOptions?: RequestInit;
}

export interface RequestAppTokenResult {
  token: string;
  expiresIn: number;
  scopes: string[];
}

/**
 * Mint a session-scoped app token from the caller's own live kernel
 * session. Returns null on any failure (unauthenticated, unregistered
 * `aud`, or the kernel being unreachable) — callers should treat null the
 * same as "could not obtain a token" and fail their own flow accordingly.
 */
export async function requestAppToken(options: RequestAppTokenOptions): Promise<RequestAppTokenResult | null> {
  try {
    const res = await fetch(`${options.authUrl}/auth/api/tokens/app`, {
      method: 'POST',
      credentials: 'include',
      ...options.fetchOptions,
      headers: { 'Content-Type': 'application/json', ...options.fetchOptions?.headers },
      body: JSON.stringify({ aud: options.aud, scopes: options.scopes ?? [] }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RequestAppTokenResult;
  } catch {
    return null;
  }
}
