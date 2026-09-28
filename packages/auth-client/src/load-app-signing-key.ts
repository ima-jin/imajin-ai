/**
 * `loadAppSigningKey` (#2411) — the boot-time call an `imajin-app-template`
 * fork makes to fetch its own vault-minted signing key from the kernel,
 * instead of reading `IMAJIN_APP_PRIVATE_KEY` out of an env file.
 *
 * `apps.provision` (kernel-side, `ima-jin/imajin-ai`) mints the app's
 * Ed25519 keypair IN the vault and grants it to the app's own DID, but the
 * app has no pre-existing identity to authenticate a normal DID
 * challenge-response fetch with — unlike `@imajin/auth`'s `loadFromVault`
 * (which assumes a caller that already holds a bootstrap keypair). Instead,
 * the operator-approval that mints the grant also issues a one-time,
 * short-TTL CLAIM CODE, shown exactly once on the /jin card and placed in
 * the app's `.env.local` as `IMAJIN_APP_CLAIM_CODE` — the ONLY credential
 * that file ever carries. This helper exchanges that code, once, for the
 * app's actual private key, via `POST {kernelUrl}/api/apps/claim`.
 *
 * ## Guarantees
 *  - Memory-only: the fetched key is returned to the caller and never
 *    written to disk, another env var, a log line, or a thrown error
 *    message.
 *  - Fails loud: unlike `@imajin/auth`'s `loadFromVault` (which lets a
 *    caller degrade gracefully when a credential is optional), a signing
 *    key IS the app's identity — this throws on any failure rather than
 *    returning a sentinel, so a misconfigured deploy fails at boot instead
 *    of silently running unsigned.
 *  - The claim code is single-use: a second call against an
 *    already-redeemed or expired code fails — ask the kernel operator to
 *    re-approve `apps.provision` for a fresh one (`POST /api/apps/provision`
 *    with `reissueClaim: true`).
 */

export interface LoadAppSigningKeyOptions {
  /** The kernel's own base URL, e.g. https://jin.imajin.ai. Defaults to `process.env.IMAJIN_KERNEL_URL`. */
  kernelUrl?: string;
  /** The one-time claim code from `.env.local`. Defaults to `process.env.IMAJIN_APP_CLAIM_CODE`. */
  claimCode?: string;
  /** Best-effort label (e.g. hostname) recorded on the kernel's /jin timeline only — never used for authorization. */
  hostHint?: string;
  /** Extra fetch options, merged under the defaults. */
  fetchOptions?: RequestInit;
}

export interface AppSigningKey {
  /** This app's own DID, as minted by `apps.provision`. */
  appDid: string;
  /** The app's Ed25519 private key, hex-encoded. Hold this in memory only. */
  privateKey: string;
  /** The corresponding public key, when the kernel returned one. */
  publicKey: string | null;
}

interface ClaimResponseBody {
  appDid?: unknown;
  privateKey?: unknown;
  publicKey?: unknown;
  error?: unknown;
}

/**
 * Exchange `IMAJIN_APP_CLAIM_CODE` for this app's own vault-minted signing
 * key. Throws (never returns null) on any failure — missing config, an
 * already-redeemed/expired code, a revoked grant, or an unreachable
 * kernel — since a signing key is load-bearing for the app's own identity.
 */
export async function loadAppSigningKey(options: LoadAppSigningKeyOptions = {}): Promise<AppSigningKey> {
  const kernelUrl = options.kernelUrl ?? process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) {
    throw new Error('loadAppSigningKey: kernelUrl is required (set IMAJIN_KERNEL_URL or pass { kernelUrl })');
  }
  const claimCode = options.claimCode ?? process.env.IMAJIN_APP_CLAIM_CODE;
  if (!claimCode) {
    throw new Error('loadAppSigningKey: claimCode is required (set IMAJIN_APP_CLAIM_CODE or pass { claimCode })');
  }

  let res: Response;
  try {
    res = await fetch(`${kernelUrl}/api/apps/claim`, {
      method: 'POST',
      ...options.fetchOptions,
      headers: { 'Content-Type': 'application/json', ...options.fetchOptions?.headers },
      body: JSON.stringify({ claimCode, ...(options.hostHint ? { hostHint: options.hostHint } : {}) }),
    });
  } catch (err) {
    throw new Error(`loadAppSigningKey: could not reach the kernel (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as ClaimResponseBody | null;
  if (!res.ok) {
    // Deliberately only the kernel's own short, value-free `error` string —
    // never any other part of the response body.
    const reason = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
    throw new Error(`loadAppSigningKey: claim exchange failed (${reason})`);
  }
  if (typeof body?.appDid !== 'string' || typeof body.privateKey !== 'string') {
    throw new Error('loadAppSigningKey: claim exchange response was malformed');
  }

  return {
    appDid: body.appDid,
    privateKey: body.privateKey,
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : null,
  };
}
