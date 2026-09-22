/**
 * Trust-on-first-use (TOFU) bootstrap for the kernel's Ed25519 signing
 * public key set (#2244, child of epic #2241) — replaces the hand-copied
 * `CORPUS_KERNEL_PUBLIC_KEY` env var that `middleware/access-claim.ts`'s
 * verifier used to read directly (#2024's env-pinned trust root).
 *
 * Precedence, evaluated once at process startup by `bootstrapKernelTrust()`
 * (see `index.ts`):
 *   1. `CORPUS_KERNEL_PUBLIC_KEY` set -> use it verbatim as the sole trusted
 *      key (backwards compatible — existing prod deployments have this
 *      set), logging a LOUD deprecation warning every boot while it
 *      remains set. No fetch, no pin-store write.
 *   2. No env var, no existing pin -> first boot: fetch the key set from
 *      `{AUTH_SERVICE_URL}/.well-known/kernel-signing-key` and pin it.
 *   3. No env var, existing pin, `CORPUS_KERNEL_PUBLIC_KEY_REPIN=1` ->
 *      explicit operator re-pin: fetch fresh and overwrite the pin with
 *      whatever the kernel serves now. One-shot and foot-gun-resistant: if
 *      the served set already equals the pin, this is a no-op (logged, not
 *      silent); if it does perform a real re-pin, it also warns the
 *      operator to unset the flag before the next boot.
 *   4. No env var, existing pin, no repin flag -> use the pinned set;
 *      best-effort re-fetch to reconcile:
 *        - if the served set shares NO kid with the pin, WARN (possible
 *          rotation or MITM) and never touch the pin.
 *        - if the served set shares at least one kid with the pin (the
 *          kernel is still vouching for a key we already trust), any
 *          newly-announced key(s) are safe to add to the pin automatically
 *          — this is the "serve both old and new during a grace window"
 *          rotation path (#2244), and needs no operator action.
 *
 * Every failure mode here (missing `AUTH_SERVICE_URL`, network error,
 * malformed response) is non-fatal — it leaves `resolveTrustedKernelPublicKeys()`
 * returning whatever it already had (a stale-but-valid pin, or `[]`),
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

interface KernelSigningKeyEntryResponse {
  kid?: unknown;
  publicKey?: unknown;
  algorithm?: unknown;
}

interface KernelSigningKeyResponse {
  keys?: unknown;
}

interface FetchedKernelKey {
  kid: string;
  publicKey: string;
}

let cachedKeys: PinnedKernelKey[] = [];
let warnedDeprecatedEnvVar = false;

/** Test-only: clears in-memory state so each test starts from a clean slate. */
export function _resetKernelTrustStateForTests(): void {
  cachedKeys = [];
  warnedDeprecatedEnvVar = false;
}

/** Logs the `CORPUS_KERNEL_PUBLIC_KEY` deprecation warning once per process (i.e. once per boot). */
function warnDeprecatedEnvVarOnce(): void {
  if (warnedDeprecatedEnvVar) return;
  warnedDeprecatedEnvVar = true;
  log.warn(
    {},
    'DEPRECATED: CORPUS_KERNEL_PUBLIC_KEY is set. Corpus now fetches and pins the kernel signing key ' +
      'via well-known + TOFU (#2244) instead. This override is honored as-is for now, but every boot ' +
      'will keep logging this warning until you unset it — on the FIRST boot after unsetting it, corpus ' +
      'performs the TOFU fetch-and-pin into data/corpus/kernel-trust.db automatically.',
  );
}

/**
 * The public key(s) access-claim verification should trust right now.
 * Checked on every call (not just at boot) so a test — or an operator —
 * setting/unsetting `CORPUS_KERNEL_PUBLIC_KEY` takes effect immediately,
 * matching the env var's previous, always-live-read behavior.
 */
export function resolveTrustedKernelPublicKeys(): string[] {
  const envKey = process.env.CORPUS_KERNEL_PUBLIC_KEY;
  if (envKey) {
    warnDeprecatedEnvVarOnce();
    return [envKey];
  }
  return cachedKeys.map((key) => key.publicKey);
}

function parseKernelSigningKeyEntry(raw: unknown): FetchedKernelKey | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kid, publicKey, algorithm } = raw as KernelSigningKeyEntryResponse;
  if (typeof kid !== 'string' || kid.length === 0) return null;
  if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) return null;
  if (algorithm !== undefined && algorithm !== 'Ed25519') return null;
  return { kid, publicKey };
}

/**
 * Parses the well-known response's `keys` array. Rejects the WHOLE
 * response (returns `null`) if any single entry is malformed — a partially
 * malformed response is more likely tampering than a benign quirk, and a
 * silently-dropped bad entry is a worse failure mode than a loud reject.
 */
function parseKernelSigningKeyResponse(body: KernelSigningKeyResponse): FetchedKernelKey[] | null {
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    log.warn({}, 'kernel-trust: well-known signing-key response has no keys array');
    return null;
  }

  const parsed: FetchedKernelKey[] = [];
  const seenKids = new Set<string>();
  for (const raw of body.keys) {
    const entry = parseKernelSigningKeyEntry(raw);
    if (!entry || seenKids.has(entry.kid)) {
      log.warn({}, 'kernel-trust: well-known signing-key response has a malformed or duplicate key entry');
      return null;
    }
    seenKids.add(entry.kid);
    parsed.push(entry);
  }
  return parsed;
}

/** Fetches+validates the kernel's published signing key set. Never throws — network/shape problems resolve to `null`. */
async function fetchKernelSigningKeys(authServiceUrl: string): Promise<FetchedKernelKey[] | null> {
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

/** Set-equality by `(kid, publicKey)`, order-independent. */
function keySetsEqual(a: ReadonlyArray<{ kid: string; publicKey: string }>, b: ReadonlyArray<{ kid: string; publicKey: string }>): boolean {
  if (a.length !== b.length) return false;
  const byKid = new Map(a.map((key) => [key.kid, key.publicKey]));
  return b.every((key) => byKid.get(key.kid) === key.publicKey);
}

/** Union of `existing` and `fetched` by `kid` — `existing` wins on a (shouldn't-happen) kid collision. */
function mergeKeySets(existing: PinnedKernelKey[], fetched: FetchedKernelKey[]): { kid: string; publicKey: string }[] {
  const byKid = new Map(existing.map((key) => [key.kid, key.publicKey]));
  for (const key of fetched) {
    if (!byKid.has(key.kid)) byKid.set(key.kid, key.publicKey);
  }
  return [...byKid.entries()].map(([kid, publicKey]) => ({ kid, publicKey }));
}

/**
 * Normal subsequent boot (no repin requested): best-effort reconciliation
 * against whatever the kernel serves now. Never re-pins on a WARN; silently
 * extends the pin when the served set still shares a trusted anchor with
 * it (the grace-window rotation path).
 */
async function reconcileWithServedKeys(store: KernelTrustStore, authServiceUrl: string | undefined, existing: PinnedKernelKey[]): Promise<void> {
  if (!authServiceUrl) return;

  const fetched = await fetchKernelSigningKeys(authServiceUrl);
  if (!fetched) return; // best-effort; caller already cached `existing`.

  const existingKids = new Set(existing.map((key) => key.kid));
  const sharesTrustedAnchor = fetched.some((key) => existingKids.has(key.kid));

  if (!sharesTrustedAnchor) {
    log.warn(
      {},
      'kernel-trust: kernel is now serving a signing key set that shares NO key with the pinned set — ' +
        'possible key rotation or MITM. Corpus keeps using the pinned set. If this rotation is expected, ' +
        're-pin explicitly with CORPUS_KERNEL_PUBLIC_KEY_REPIN=1 on the next boot.',
    );
    return;
  }

  const merged = mergeKeySets(existing, fetched);
  if (keySetsEqual(existing, merged)) return; // nothing new announced — no-op, no log needed.

  store.pinSet(merged, new Date().toISOString());
  cachedKeys = merged.map((key) => ({ ...key, pinnedAt: new Date().toISOString() }));
  log.info(
    {},
    'kernel-trust: pin set extended with newly announced key(s) — the previously pinned key is still ' +
      'being served, so trust carries over automatically (grace-window rotation)',
  );
}

/** No `AUTH_SERVICE_URL` to fetch from — keep whatever was already pinned (if anything) and log why. */
function bootstrapWithoutAuthServiceUrl(existing: PinnedKernelKey[]): void {
  if (existing.length > 0) cachedKeys = existing;
  log.warn(
    {},
    'kernel-trust: AUTH_SERVICE_URL not set — cannot fetch kernel signing key' +
      (existing.length > 0
        ? ' for re-pin; keeping the existing pin'
        : '; corpus will reject every CorpusAccessClaim until one is available'),
  );
}

/**
 * First boot (no pin yet) or an explicit `CORPUS_KERNEL_PUBLIC_KEY_REPIN=1`
 * re-pin: fetch fresh and persist it, unless the repin flag is set and the
 * fetched set already equals the existing pin — in that case, do nothing
 * and tell the operator the flag was a no-op (one-shot, foot-gun-resistant
 * per #2244's review: leaving REPIN=1 set should not mean "re-fetch and
 * overwrite the pin on every boot forever").
 */
async function pinOrRepin(store: KernelTrustStore, authServiceUrl: string, existing: PinnedKernelKey[], forceRepin: boolean): Promise<void> {
  const fetched = await fetchKernelSigningKeys(authServiceUrl);
  if (!fetched) {
    if (existing.length > 0) {
      cachedKeys = existing;
      log.warn({}, forceRepin ? 'kernel-trust: re-pin requested but fetch failed — keeping the existing pin' : 'kernel-trust: fetch failed — keeping the existing pin');
    } else {
      log.warn({}, 'kernel-trust: first-boot fetch failed — no kernel signing key pinned yet');
    }
    return;
  }

  if (forceRepin && existing.length > 0 && keySetsEqual(existing, fetched)) {
    cachedKeys = existing;
    log.warn(
      {},
      'kernel-trust: CORPUS_KERNEL_PUBLIC_KEY_REPIN=1 is set, but the pinned key set already matches what ' +
        'the kernel serves — no re-pin was needed. Unset CORPUS_KERNEL_PUBLIC_KEY_REPIN now.',
    );
    return;
  }

  store.pinSet(fetched, new Date().toISOString());
  cachedKeys = fetched.map((key) => ({ ...key, pinnedAt: new Date().toISOString() }));
  log.info({}, existing.length > 0 ? 'kernel-trust: re-pinned kernel signing key set (explicit operator action)' : 'kernel-trust: pinned kernel signing key set (trust-on-first-use)');

  if (forceRepin) {
    log.warn(
      {},
      'kernel-trust: CORPUS_KERNEL_PUBLIC_KEY_REPIN is still set — unset it now, or every future boot will ' +
        'keep re-fetching and overwriting the pin, defeating TOFU.',
    );
  }
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
    // resolveTrustedKernelPublicKeys() reads the env var directly and warns
    // there too — this call makes sure the warning fires at boot even if
    // corpus never receives a single request.
    warnDeprecatedEnvVarOnce();
    return;
  }

  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const forceRepin = process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN === '1';
  const store = options.store ?? new KernelTrustStore();

  try {
    const existing = store.getAll();

    if (existing.length > 0 && !forceRepin) {
      cachedKeys = existing;
      await reconcileWithServedKeys(store, authServiceUrl, existing);
      return;
    }

    if (!authServiceUrl) {
      bootstrapWithoutAuthServiceUrl(existing);
      return;
    }

    await pinOrRepin(store, authServiceUrl, existing, forceRepin);
  } finally {
    if (!options.store) store.close();
  }
}
