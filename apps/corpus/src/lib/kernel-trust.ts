/**
 * Trust-on-first-use (TOFU) bootstrap for the kernel's Ed25519 signing
 * public key (#2244, child of epic #2241) — replaces the hand-copied
 * `CORPUS_KERNEL_PUBLIC_KEY` env var that `middleware/access-claim.ts`'s
 * verifier used to read directly (#2024's env-pinned trust root).
 *
 * Precedence, evaluated once at process startup by `bootstrapKernelTrust()`
 * (see `index.ts`):
 *   1. `CORPUS_KERNEL_PUBLIC_KEY` set -> use it verbatim (backwards
 *      compatible), log a one-time deprecation warning, and skip TOFU
 *      entirely — no fetch, no pin-store write.
 *   2. No env var, no existing pin -> first boot: fetch the key from
 *      `{AUTH_SERVICE_URL}/.well-known/kernel-signing-key` and pin it.
 *   3. No env var, existing pin, `CORPUS_KERNEL_PUBLIC_KEY_REPIN=1` ->
 *      explicit operator re-pin: fetch fresh and overwrite the pin
 *      regardless of what is currently pinned.
 *   4. No env var, existing pin, no repin flag -> use the pinned value;
 *      best-effort re-fetch to compare, and WARN (never silently re-pin)
 *      if the kernel is now serving a different key.
 *
 * Every failure mode here (missing `AUTH_SERVICE_URL`, network error,
 * malformed response) is non-fatal — it leaves `resolveTrustedKernelPublicKey()`
 * returning whatever it already had (a stale-but-valid pin, or `null`),
 * matching this codebase's existing soft-fail-on-optional-identity-config
 * pattern (`corpus-identity.ts`). `access-claim.ts` already 401s cleanly
 * when no trusted key is available at all.
 */
import { createLogger } from '@imajin/logger';
import { isValidPublicKey } from '@imajin/auth';
import { KernelTrustStore, type PinnedKernelKey } from './kernel-trust-store';

const log = createLogger('corpus');

const WELL_KNOWN_PATH = '/.well-known/kernel-signing-key';
const FETCH_TIMEOUT_MS = 5_000;

interface KernelSigningKeyResponse {
  kid?: unknown;
  alg?: unknown;
  publicKey?: unknown;
}

interface FetchedKernelKey {
  publicKey: string;
  kid: string | null;
}

let cachedPublicKey: string | null = null;
let warnedDeprecatedEnvVar = false;

/** Test-only: clears in-memory state so each test starts from a clean slate. */
export function _resetKernelTrustStateForTests(): void {
  cachedPublicKey = null;
  warnedDeprecatedEnvVar = false;
}

/**
 * The public key access-claim verification should trust right now.
 * Checked on every call (not just at boot) so a test — or an operator —
 * setting/unsetting `CORPUS_KERNEL_PUBLIC_KEY` takes effect immediately,
 * matching the env var's previous, always-live-read behavior.
 */
export function resolveTrustedKernelPublicKey(): string | null {
  const envKey = process.env.CORPUS_KERNEL_PUBLIC_KEY;
  if (!envKey) return cachedPublicKey;

  if (!warnedDeprecatedEnvVar) {
    warnedDeprecatedEnvVar = true;
    log.warn(
      {},
      'CORPUS_KERNEL_PUBLIC_KEY is deprecated — corpus now fetches and pins the kernel signing key ' +
        'via well-known + TOFU (#2244). Unset it to switch over; it is honored as-is until then.',
    );
  }
  return envKey;
}

function parseKernelSigningKeyResponse(body: KernelSigningKeyResponse): FetchedKernelKey | null {
  if (typeof body.publicKey !== 'string' || !isValidPublicKey(body.publicKey)) {
    log.warn({}, 'kernel-trust: well-known signing-key response has no valid publicKey');
    return null;
  }
  if (body.alg !== undefined && body.alg !== 'Ed25519') {
    log.warn({ alg: body.alg }, 'kernel-trust: well-known signing-key response has an unsupported alg');
    return null;
  }
  return { publicKey: body.publicKey, kid: typeof body.kid === 'string' ? body.kid : null };
}

/** Fetches+validates the kernel's published signing key. Never throws — network/shape problems resolve to `null`. */
async function fetchKernelSigningKey(authServiceUrl: string): Promise<FetchedKernelKey | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${authServiceUrl}${WELL_KNOWN_PATH}`, { signal: controller.signal });
    if (!res.ok) {
      log.warn({ status: res.status }, 'kernel-trust: well-known signing-key fetch returned non-2xx');
      return null;
    }
    return parseKernelSigningKeyResponse((await res.json()) as KernelSigningKeyResponse);
  } catch (err) {
    log.warn({ err: String(err) }, 'kernel-trust: well-known signing-key fetch failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Best-effort: fetches the currently-served key and WARNs (never re-pins) if it differs from `existing`. */
async function warnOnMismatch(authServiceUrl: string | undefined, existing: PinnedKernelKey): Promise<void> {
  if (!authServiceUrl) return;

  const fetched = await fetchKernelSigningKey(authServiceUrl);
  if (fetched && fetched.publicKey !== existing.publicKey) {
    log.warn(
      {},
      'kernel-trust: kernel is now serving a DIFFERENT signing public key than the pinned one — ' +
        'possible key rotation or MITM. Corpus keeps using the pinned key. If this rotation is ' +
        'expected, re-pin explicitly with CORPUS_KERNEL_PUBLIC_KEY_REPIN=1 on the next boot.',
    );
  }
}

/** No `AUTH_SERVICE_URL` to fetch from — keep whatever was already pinned (if anything) and log why. */
function bootstrapWithoutAuthServiceUrl(existing: PinnedKernelKey | null): void {
  if (existing) cachedPublicKey = existing.publicKey;
  log.warn(
    {},
    'kernel-trust: AUTH_SERVICE_URL not set — cannot fetch kernel signing key' +
      (existing
        ? ' for re-pin; keeping the existing pin'
        : '; corpus will reject every CorpusAccessClaim until one is available'),
  );
}

/** First boot (no pin yet) or an explicit operator re-pin: fetch fresh and persist it. */
async function pinFreshKey(store: KernelTrustStore, authServiceUrl: string, existing: PinnedKernelKey | null): Promise<void> {
  const fetched = await fetchKernelSigningKey(authServiceUrl);
  if (!fetched) {
    if (existing) {
      cachedPublicKey = existing.publicKey;
      log.warn({}, 'kernel-trust: re-pin requested but fetch failed — keeping the existing pin');
    } else {
      log.warn({}, 'kernel-trust: first-boot fetch failed — no kernel signing key pinned yet');
    }
    return;
  }

  store.pin(fetched.publicKey, fetched.kid, new Date().toISOString());
  cachedPublicKey = fetched.publicKey;
  log.info(
    {},
    existing
      ? 'kernel-trust: re-pinned kernel signing key (explicit operator action)'
      : 'kernel-trust: pinned kernel signing key (trust-on-first-use)',
  );
}

export interface BootstrapKernelTrustOptions {
  /** Injectable for tests — defaults to a fresh `KernelTrustStore()` over `data/corpus`. */
  store?: KernelTrustStore;
}

/**
 * Runs once at process startup, before the HTTP server starts accepting
 * requests (see `index.ts`). Safe to call multiple times (e.g. in tests) —
 * each call re-evaluates the precedence above from scratch.
 */
export async function bootstrapKernelTrust(options: BootstrapKernelTrustOptions = {}): Promise<void> {
  if (process.env.CORPUS_KERNEL_PUBLIC_KEY) {
    // resolveTrustedKernelPublicKey() reads the env var directly — nothing
    // to fetch, pin, or cache here.
    return;
  }

  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const forceRepin = process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN === '1';
  const store = options.store ?? new KernelTrustStore();

  try {
    const existing = store.get();

    if (existing && !forceRepin) {
      cachedPublicKey = existing.publicKey;
      await warnOnMismatch(authServiceUrl, existing);
      return;
    }

    if (!authServiceUrl) {
      bootstrapWithoutAuthServiceUrl(existing);
      return;
    }

    await pinFreshKey(store, authServiceUrl, existing);
  } finally {
    if (!options.store) store.close();
  }
}
