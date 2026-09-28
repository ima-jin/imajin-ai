/**
 * `loadAppSigningKey` (#2411) — the boot-time call an `imajin-app-template`
 * fork makes to fetch its own vault-minted signing key from the kernel,
 * instead of reading `IMAJIN_APP_PRIVATE_KEY` out of an env file.
 *
 * ## First boot vs. every later boot (restart-authentication ruling)
 * `apps.provision` (kernel-side, `ima-jin/imajin-ai`) mints the app's
 * Ed25519 keypair IN the vault and grants it to the app's own DID, but the
 * app has no pre-existing identity to authenticate a normal vault fetch
 * with. Rather than spending a fresh operator-approved one-time claim code
 * on EVERY boot, this module:
 *  1. **First boot** (no local keystore yet): requires a one-time claim
 *     code (`IMAJIN_APP_CLAIM_CODE`), mints its OWN Ed25519 "bootstrap"
 *     keypair (`./ed25519.ts`), and exchanges the claim code — together
 *     with the bootstrap PUBLIC key — for the real signing key via
 *     `POST /api/apps/claim`. The bootstrap keypair is persisted in a local
 *     keystore file (`./keystore.ts`, `0600`, default
 *     `./.imajin/keystore.json`) ONLY after a successful exchange — never
 *     the actual signing key itself.
 *  2. **Every later boot** (keystore already present): signs a fresh,
 *     short-lived challenge with the bootstrap private key and fetches the
 *     signing key via `POST /api/apps/signing-key/fetch` — no claim code
 *     spent, no operator action needed.
 *
 * ## Guarantees
 *  - Memory-only: the fetched SIGNING key is returned to the caller and
 *    never written to disk, another env var, a log line, or a thrown error
 *    message. Only the narrow-purpose bootstrap keypair ever touches disk.
 *  - Fails loud: unlike `@imajin/auth`'s `loadFromVault` (which lets a
 *    caller degrade gracefully when a credential is optional), a signing
 *    key IS the app's identity — this throws on any failure rather than
 *    returning a sentinel, so a misconfigured deploy fails at boot instead
 *    of silently running unsigned.
 *  - A spent claim code never redeems twice: if the keystore is lost (e.g.
 *    disk wipe) after its bootstrap key was already bound, ask the kernel
 *    operator to re-approve `apps.provision` with `reissueClaim: true` for
 *    a fresh code — that also revokes the lost key's binding.
 */
import { randomUUID } from 'node:crypto';
import { generateBootstrapKeypair, signBootstrapPayload, canonicalizeBootstrapFetchPayload, type BootstrapKeypair } from './ed25519';
import { readKeystore, writeKeystore, resolveKeystorePath } from './keystore';

export interface LoadAppSigningKeyOptions {
  /** The kernel's own base URL, e.g. https://jin.imajin.ai. Defaults to `process.env.IMAJIN_KERNEL_URL`. */
  kernelUrl?: string;
  /** This app's own DID, as minted by `apps.provision`. Defaults to `process.env.IMAJIN_APP_DID`. Required for a subsequent-boot (keystore-present) fetch. */
  appDid?: string;
  /** The one-time claim code from `.env.local`. Defaults to `process.env.IMAJIN_APP_CLAIM_CODE`. Required only on first boot (no keystore yet). */
  claimCode?: string;
  /** Where the bootstrap keypair is persisted. Defaults to `process.env.IMAJIN_APP_KEYSTORE`, then `./.imajin/keystore.json`. */
  keystorePath?: string;
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

interface SigningKeyResponseBody {
  appDid?: unknown;
  privateKey?: unknown;
  publicKey?: unknown;
  error?: unknown;
}

/** POSTs `body` to `${kernelUrl}${path}` and parses the shared `{ appDid, privateKey, publicKey }` response shape. Throws a value-free, descriptive error on any failure. */
async function postForSigningKey(
  kernelUrl: string,
  path: string,
  body: Record<string, unknown>,
  fetchOptions: RequestInit | undefined,
  failureContext: string,
): Promise<AppSigningKey> {
  let res: Response;
  try {
    res = await fetch(`${kernelUrl}${path}`, {
      method: 'POST',
      ...fetchOptions,
      headers: { 'Content-Type': 'application/json', ...fetchOptions?.headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`loadAppSigningKey: could not reach the kernel (${err instanceof Error ? err.message : String(err)})`);
  }

  const responseBody = (await res.json().catch(() => null)) as SigningKeyResponseBody | null;
  if (!res.ok) {
    // Deliberately only the kernel's own short, value-free `error` string —
    // never any other part of the response body.
    const reason = typeof responseBody?.error === 'string' ? responseBody.error : `status ${res.status}`;
    throw new Error(`loadAppSigningKey: ${failureContext} failed (${reason})`);
  }
  if (typeof responseBody?.appDid !== 'string' || typeof responseBody.privateKey !== 'string') {
    throw new Error(`loadAppSigningKey: ${failureContext} response was malformed`);
  }

  return {
    appDid: responseBody.appDid,
    privateKey: responseBody.privateKey,
    publicKey: typeof responseBody.publicKey === 'string' ? responseBody.publicKey : null,
  };
}

/** First boot: exchange a one-time claim code (+ the freshly minted bootstrap public key) for the signing key. */
async function claimFirstBoot(params: {
  kernelUrl: string;
  claimCode: string;
  bootstrapPublicKey: string;
  hostHint?: string;
  fetchOptions?: RequestInit;
}): Promise<AppSigningKey> {
  return postForSigningKey(
    params.kernelUrl,
    '/api/apps/claim',
    {
      claimCode: params.claimCode,
      bootstrapPublicKey: params.bootstrapPublicKey,
      ...(params.hostHint ? { hostHint: params.hostHint } : {}),
    },
    params.fetchOptions,
    'claim exchange',
  );
}

/** Every later boot: sign a fresh challenge with the bootstrap key and fetch the signing key. */
async function fetchWithBootstrapKey(params: {
  kernelUrl: string;
  appDid: string;
  keystore: BootstrapKeypair;
  fetchOptions?: RequestInit;
}): Promise<AppSigningKey> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const canonical = canonicalizeBootstrapFetchPayload({ appDid: params.appDid, nonce, timestamp });
  const signature = signBootstrapPayload(canonical, params.keystore.privateKey);

  return postForSigningKey(
    params.kernelUrl,
    '/api/apps/signing-key/fetch',
    { appDid: params.appDid, timestamp, nonce, signature },
    params.fetchOptions,
    'bootstrap-key fetch',
  );
}

/**
 * Fetches this app's own vault signing key — via the local bootstrap
 * keystore when one already exists, or via a one-time claim code on first
 * boot. Throws (never returns null) on any failure, since a signing key is
 * load-bearing for the app's own identity.
 */
export async function loadAppSigningKey(options: LoadAppSigningKeyOptions = {}): Promise<AppSigningKey> {
  const kernelUrl = options.kernelUrl ?? process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) {
    throw new Error('loadAppSigningKey: kernelUrl is required (set IMAJIN_KERNEL_URL or pass { kernelUrl })');
  }

  const keystorePath = resolveKeystorePath(options.keystorePath);
  const keystore = readKeystore(keystorePath);

  if (keystore) {
    const appDid = options.appDid ?? process.env.IMAJIN_APP_DID;
    if (!appDid) {
      throw new Error('loadAppSigningKey: appDid is required once a keystore exists (set IMAJIN_APP_DID or pass { appDid })');
    }
    return fetchWithBootstrapKey({ kernelUrl, appDid, keystore, fetchOptions: options.fetchOptions });
  }

  const claimCode = options.claimCode ?? process.env.IMAJIN_APP_CLAIM_CODE;
  if (!claimCode) {
    throw new Error(
      `loadAppSigningKey: no keystore found at '${keystorePath}' and no claim code provided — first boot requires ` +
        'IMAJIN_APP_CLAIM_CODE (from the /jin operator-approval reveal) or { claimCode }',
    );
  }

  const bootstrapKeypair = generateBootstrapKeypair();
  const signingKey = await claimFirstBoot({
    kernelUrl,
    claimCode,
    bootstrapPublicKey: bootstrapKeypair.publicKey,
    hostHint: options.hostHint,
    fetchOptions: options.fetchOptions,
  });
  // Persisted only AFTER a successful exchange, so a failed first attempt
  // never leaves behind a keystore bound to nothing on the kernel side.
  writeKeystore(keystorePath, bootstrapKeypair);

  return signingKey;
}
