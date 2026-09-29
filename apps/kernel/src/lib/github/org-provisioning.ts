/**
 * GitHub org-scoped provisioning (#2375, #2416) — the credential + REST
 * calls `apps.provision` uses to create an extracted app's repo and seal
 * its deploy secrets. Deliberately separate from `./connector.ts`: that
 * module is a PER-DID OAuth/PAT connector for issue/PR automation on
 * behalf of a human, gated by `channel_links` + the confirm rail. This
 * module has no per-DID concept at all — it is the KERNEL's own org-wide
 * identity, ruled by Ryan 2026-09-24 (#2375): "the kernel does it with an
 * org-scoped credential; no org-admin grant to `warp-factories[bot]`".
 *
 * ## Credential custody (#2416: a GitHub App installation, not a PAT)
 * Ruled by Ryan 2026-09-28 (#2416): the `ima-jin` org does not issue GitHub
 * PATs. The credential is a GitHub App (`imajin-provisioner`) installed on
 * the org — same identity model as `warp-factories[bot]`. The sealed
 * {@link GITHUB_ORG_CREDENTIAL_FIELD} vault field holds a JSON blob
 * (`{ appId, installationId, privateKeyPem }`, see {@link OrgAppCredential}),
 * sealed ONCE by the operator via the existing generic `POST /api/vault/set`
 * route with `custodyScheme: 'delegation-grant'` (v2 self-granted to the
 * node, #2311's "v2 grant shape") — no new sealing route. See
 * `docs/REGISTRATION.md` for the App's setup (permissions, installation).
 * Nothing long-lived that can act on GitHub directly is stored: every
 * actual GitHub call authenticates with a short-lived installation access
 * token minted on demand by {@link getInstallationToken} and cached only
 * in memory (see that function's docblock) — every GitHub action this
 * module takes lands in the org audit log as `imajin-provisioner[bot]`.
 *
 * ## Actions secrets
 * GitHub's Actions-secrets API requires the plaintext to be encrypted
 * client-side with libsodium's anonymous sealed-box construction
 * (`crypto_box_seal`) against the target repo's own Actions public key
 * before `PUT .../actions/secrets/{name}` — this is GitHub's own
 * documented mechanism, not an imajin-specific choice. `libsodium-wrappers`
 * is used here (rather than hand-rolling the X25519/HSalsa20/XSalsa20-
 * Poly1305 sealed-box construction from lower-level primitives) because a
 * subtle byte-order bug in a hand-rolled implementation would silently
 * produce a token GitHub cannot decrypt, or worse — this is exactly the
 * kind of crypto correctness question this codebase's own vault module
 * refuses to reinvent.
 *
 * ## Nav manifest read (#2425)
 * {@link fetchAppManifest} is a best-effort read of `imajin.app.json` from
 * the app's own (private) repo at `apps.provision` time — nav metadata an
 * extracted app can publish about itself. It uses the SAME installation
 * token as every other call in this module (passed in by the caller, see
 * `provision.ts`'s use of {@link tryGetInstallationToken}), never a
 * separate credential.
 *
 * No secret value (the App private key, a minted installation token, or a
 * minted app-auth private key) is ever logged.
 */
import { createRequire } from 'node:module';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { createLogger } from '@imajin/logger';
import { loadAndUnseal } from '@/src/lib/vault';
import type sodiumWrappersType from 'libsodium-wrappers';

// `libsodium-wrappers`'s published ESM build (dist/modules-esm/libsodium-wrappers.mjs)
// imports a sibling `./libsodium.mjs` that is not actually included in the npm
// package's `files` allowlist, so resolving it via a normal ESM `import` throws
// "Cannot find module ... libsodium.mjs" under Node's/Vite's strict ESM resolver.
// The CJS build (dist/modules/libsodium-wrappers.js, the `require` export
// condition) has no such issue — it resolves the `libsodium` dependency through
// ordinary node_modules resolution — so it is loaded explicitly via `require`
// rather than a static `import`.
const require = createRequire(import.meta.url);
const sodium: typeof sodiumWrappersType = require('libsodium-wrappers');

const log = createLogger('kernel:github:org-provisioning');

/** GitHub org every first-party app is provisioned under. */
export const PROVISIONING_ORG = 'ima-jin';

/** Default template repo `apps.provision` generates a new app repo from. */
export const DEFAULT_APP_TEMPLATE = 'ima-jin/imajin-app-template';

/**
 * Vault field holding the kernel-wide, org-scoped GitHub App installation
 * credential (#2375, #2416). Sealed once by the operator via
 * `POST /api/vault/set` (`custodyScheme: 'delegation-grant'`) — see this
 * module's docblock.
 */
export const GITHUB_ORG_CREDENTIAL_FIELD = 'github-org-provisioning';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/**
 * The sealed shape of {@link GITHUB_ORG_CREDENTIAL_FIELD} (#2416): a GitHub
 * App installation identity — never a token that can act on GitHub
 * directly. `privateKeyPem` is the App's own RSA private key, used only to
 * sign short-lived JWTs (see {@link getInstallationToken}), never sent to
 * GitHub itself.
 */
export interface OrgAppCredential {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

/** Thrown when the org-scoped credential has never been sealed. */
export class OrgCredentialMissingError extends Error {
  /** `message` defaults to the generic "not sealed" notice; a caller with more specific context (e.g. a missing repo) may override it. */
  constructor(message?: string) {
    super(
      message ??
      `${GITHUB_ORG_CREDENTIAL_FIELD} is not sealed — an operator must seal an org-scoped ` +
      `GitHub App installation credential via POST /api/vault/set before apps.provision can ` +
      `create repos or seal deploy secrets (see docs/REGISTRATION.md)`,
    );
    this.name = 'OrgCredentialMissingError';
  }
}

/**
 * Thrown when {@link GITHUB_ORG_CREDENTIAL_FIELD} IS sealed but does not
 * unmarshal to a well-formed {@link OrgAppCredential} — e.g. a stale
 * pre-#2416 PAT string, truncated JSON, or a blob missing one of the three
 * required fields. Mirrors {@link OrgCredentialMissingError}'s
 * one-error-per-cause shape, but as a `TypeError` (the sealed value's
 * *type/shape* is wrong, not merely absent) so callers can tell "never
 * sealed" apart from "sealed wrong" without string-matching messages.
 */
export class OrgCredentialMalformedError extends TypeError {
  constructor(reason: string) {
    super(
      `${GITHUB_ORG_CREDENTIAL_FIELD} is sealed but malformed (${reason}) — expected JSON ` +
      `{ appId, installationId, privateKeyPem } for a GitHub App installation (see docs/REGISTRATION.md)`,
    );
    this.name = 'OrgCredentialMalformedError';
  }
}

function requireCredentialStringField(parsed: Record<string, unknown>, field: keyof OrgAppCredential): string {
  const value = parsed[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OrgCredentialMalformedError(`"${field}" must be a non-empty string`);
  }
  return value;
}

/** Parse + validate the raw sealed value as an {@link OrgAppCredential}. */
function parseOrgAppCredential(raw: string): OrgAppCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrgCredentialMalformedError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrgCredentialMalformedError('expected a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  return {
    appId: requireCredentialStringField(record, 'appId'),
    installationId: requireCredentialStringField(record, 'installationId'),
    privateKeyPem: requireCredentialStringField(record, 'privateKeyPem'),
  };
}

/**
 * Load + parse the org-scoped GitHub App installation credential. Throws
 * {@link OrgCredentialMissingError} if it has never been sealed, or
 * {@link OrgCredentialMalformedError} if the sealed value doesn't unmarshal
 * to a well-formed {@link OrgAppCredential}. Never logged. Callers that
 * need to actually call the GitHub API should use
 * {@link getInstallationToken} instead — this is exported mainly for that
 * function and for direct testing of the parse/validate contract.
 */
export async function loadOrgCredential(): Promise<OrgAppCredential> {
  const raw = await loadAndUnseal(GITHUB_ORG_CREDENTIAL_FIELD);
  if (raw === undefined) {
    throw new OrgCredentialMissingError();
  }
  return parseOrgAppCredential(raw);
}

// ── Installation token minting (#2416) ─────────────────────────────────

/** GitHub's hard cap on a GitHub App JWT's total (iat -> exp) lifetime. */
const APP_JWT_MAX_LIFETIME_SECONDS = 10 * 60;
/** Backdate `iat` by this much to tolerate clock drift — GitHub's own recommendation. */
const APP_JWT_CLOCK_SKEW_SECONDS = 60;
/** Refresh the cached installation token this far ahead of its real expiry. */
const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

let cachedInstallationToken: CachedInstallationToken | undefined;

/**
 * Mint a short-lived RS256 App JWT (`iss: appId`, `iat` backdated 60s,
 * `exp` <= 10 minutes total lifetime — GitHub's own requirements). The key
 * is loaded via `node:crypto`'s `createPrivateKey` (rather than jose's own
 * `importPKCS8`) because GitHub Apps' downloadable private keys are PKCS#1
 * (`-----BEGIN RSA PRIVATE KEY-----`), not PKCS#8, and jose's `importPKCS8`
 * strictly rejects that format; `createPrivateKey` auto-detects either PEM
 * encoding and returns a `KeyObject` jose's `SignJWT.sign` accepts
 * natively. The JWT is used exactly once, to mint an installation token —
 * it is never returned, logged, or cached itself.
 */
async function mintAppJwt(credential: OrgAppCredential): Promise<string> {
  const privateKey = createPrivateKey(credential.privateKeyPem);
  const issuedAt = Math.floor(Date.now() / 1000) - APP_JWT_CLOCK_SKEW_SECONDS;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + APP_JWT_MAX_LIFETIME_SECONDS)
    .setIssuer(credential.appId)
    .sign(privateKey);
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

async function mintInstallationToken(credential: OrgAppCredential): Promise<CachedInstallationToken> {
  const appJwt = await mintAppJwt(credential);
  const response = await callGitHubApi<InstallationTokenResponse>({
    method: 'POST',
    path: `/app/installations/${credential.installationId}/access_tokens`,
    token: appJwt,
  });
  if (response.status !== 201 || !response.data) {
    throw new Error(
      `apps.provision: failed to mint an installation token for installation '${credential.installationId}' (GitHub status ${response.status})`,
    );
  }
  const expiresAtMs = Date.parse(response.data.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    throw new RangeError(
      `apps.provision: installation token response had an unparsable "expires_at" value ('${response.data.expires_at}')`,
    );
  }
  log.info({ installationId: credential.installationId }, 'apps.provision: minted a fresh GitHub App installation token');
  return { token: response.data.token, expiresAtMs };
}

/**
 * Get a live GitHub App installation access token (#2416), minting a fresh
 * one only when none is cached or the cached one is within
 * {@link INSTALLATION_TOKEN_REFRESH_MARGIN_MS} of its real `expires_at`.
 * Cached ONLY in this module's in-memory state — never persisted, never
 * logged. Every GitHub call made with this token lands in the org audit
 * log as `imajin-provisioner[bot]`, not as any human or the kernel's own
 * identity.
 */
export async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  if (cachedInstallationToken && cachedInstallationToken.expiresAtMs - INSTALLATION_TOKEN_REFRESH_MARGIN_MS > now) {
    return cachedInstallationToken.token;
  }
  const credential = await loadOrgCredential();
  cachedInstallationToken = await mintInstallationToken(credential);
  return cachedInstallationToken.token;
}

/** Test-only: reset the cached installation token between test cases. */
export function __resetInstallationTokenCacheForTests(): void {
  cachedInstallationToken = undefined;
}

/**
 * Best-effort variant of {@link getInstallationToken} — `null` (never
 * throws) when the org credential has never been sealed, so callers that
 * need to branch on "is it sealed at all" (#2415: the repo existence check
 * / authenticated retry, and `sealDeploySecrets`'s degrade-instead-of-fail
 * path) don't need exception-driven control flow. Returns a real,
 * ready-to-use installation access token (not the raw sealed credential)
 * so callers can hand it straight to {@link callGitHubApi}. Any OTHER
 * error — a malformed blob ({@link OrgCredentialMalformedError}), or a
 * genuine vault/GitHub failure — still propagates; only "never sealed" is
 * treated as the soft, expected case.
 */
export async function tryGetInstallationToken(): Promise<string | null> {
  try {
    return await getInstallationToken();
  } catch (err) {
    if (err instanceof OrgCredentialMissingError) return null;
    throw err;
  }
}

interface GitHubApiOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  /** Omit for an unauthenticated call — e.g. #2415's repo existence check, which must not require the org credential. */
  token?: string;
  body?: Record<string, unknown>;
}

/**
 * Call the GitHub REST API, optionally with the org-scoped credential.
 * Returns `{ status, data }` rather than throwing on non-2xx, so callers can
 * branch on 404 (e.g. "repo does not exist yet") without exception-driven
 * control flow. The token (when supplied) is only ever used in the
 * Authorization header — never logged.
 */
async function callGitHubApi<T = unknown>(opts: Readonly<GitHubApiOptions>): Promise<{ status: number; data: T | null }> {
  const url = opts.path.startsWith('http') ? opts.path : `${GITHUB_API_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'imajin-kernel-apps-provision/1.0',
  };
  if (opts.token !== undefined) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  if (res.status === 204) {
    return { status: res.status, data: null };
  }
  const text = await res.text();
  const data = text.length > 0 ? (JSON.parse(text) as T) : null;
  return { status: res.status, data };
}

export interface EnsureRepoResult {
  repoUrl: string;
  /** true when THIS call created the repo; false when an existing repo was found and reused. */
  created: boolean;
}

interface GitHubRepoResponse {
  html_url: string;
  full_name: string;
}

function repoExistenceCheckPath(slug: string): string {
  return `/repos/${PROVISIONING_ORG}/${slug}`;
}

/** #2415: the repo can always be created out of band while the org credential is unsealed — this is the message that unblocks an operator/agent stuck on this step. */
function missingRepoWithUnsealedCredentialError(slug: string, template: string): OrgCredentialMissingError {
  return new OrgCredentialMissingError(
    `ima-jin/${slug} does not exist and ${GITHUB_ORG_CREDENTIAL_FIELD} is not sealed — create it out of band with ` +
    `'gh repo create ima-jin/${slug} --template ${template}' and re-run apps.provision, or seal an org-scoped ` +
    `GitHub credential via POST /api/vault/set first (see docs/REGISTRATION.md)`,
  );
}

async function createRepoFromTemplate(slug: string, template: string, token: string): Promise<EnsureRepoResult> {
  const created = await callGitHubApi<GitHubRepoResponse>({
    method: 'POST',
    path: `/repos/${template}/generate`,
    token,
    body: { owner: PROVISIONING_ORG, name: slug, private: true, include_all_branches: false },
  });
  if (created.status !== 201 || !created.data) {
    throw new Error(`apps.provision: failed to create repo '${slug}' from template '${template}' (GitHub status ${created.status})`);
  }

  log.info({ slug, repo: created.data.full_name }, 'apps.provision: repo created from template');
  return { repoUrl: created.data.html_url, created: true };
}

/**
 * The anonymous check came back with neither a confirmed-exists (200) nor a
 * confirmed-missing (404) status — could be rate limiting, or a private repo
 * an anonymous call can't see. Retry once, authenticated, only if a
 * credential exists; there is nothing further to try when it doesn't.
 */
async function resolveAmbiguousRepoStatus(
  slug: string,
  template: string,
  anonymousStatus: number,
  token: string | null,
): Promise<EnsureRepoResult> {
  if (token === null) {
    throw new Error(`apps.provision: failed to check for existing repo '${slug}' (GitHub status ${anonymousStatus})`);
  }

  const retried = await callGitHubApi<GitHubRepoResponse>({ method: 'GET', path: repoExistenceCheckPath(slug), token });
  if (retried.status === 200 && retried.data) {
    log.info({ slug, repo: retried.data.full_name }, 'apps.provision: repo already exists — skipping creation');
    return { repoUrl: retried.data.html_url, created: false };
  }
  if (retried.status === 404) {
    return createRepoFromTemplate(slug, template, token);
  }
  throw new Error(`apps.provision: failed to check for existing repo '${slug}' (GitHub status ${retried.status})`);
}

/**
 * Idempotent repo provisioning (#2375 acceptance: "repo creation must be
 * idempotent/skippable when the repo exists"; #2415: idempotent/skippable
 * WITHOUT requiring the org credential at all).
 *
 * The existence check runs UNAUTHENTICATED first — a public-org repo's
 * existence is visible with no token, and the org credential must never be
 * a precondition for recognizing "the repo is already there" (#2415's bug:
 * an unsealed credential used to fail the whole chain before GitHub was
 * even asked). The credential is only loaded once the anonymous check comes
 * back inconclusive:
 *   - confirmed missing (404) — needed to actually create the repo, or (if
 *     unsealed) to explain that it can be created out of band instead;
 *   - anything else (e.g. rate limiting, or a private repo an anonymous
 *     call can't see) — used for one authenticated retry before failing.
 */
export async function ensureRepoFromTemplate(
  slug: string,
  template: string = DEFAULT_APP_TEMPLATE,
): Promise<EnsureRepoResult> {
  const anonymous = await callGitHubApi<GitHubRepoResponse>({ method: 'GET', path: repoExistenceCheckPath(slug) });
  if (anonymous.status === 200 && anonymous.data) {
    log.info({ slug, repo: anonymous.data.full_name }, 'apps.provision: repo already exists — skipping creation');
    return { repoUrl: anonymous.data.html_url, created: false };
  }

  const token = await tryGetInstallationToken();

  if (anonymous.status === 404) {
    if (token === null) {
      throw missingRepoWithUnsealedCredentialError(slug, template);
    }
    return createRepoFromTemplate(slug, template, token);
  }

  return resolveAmbiguousRepoStatus(slug, template, anonymous.status, token);
}

interface ActionsPublicKeyResponse {
  key_id: string;
  key: string;
}

/** Nav metadata (#2425) an app can publish about itself via `imajin.app.json` at its repo root. */
export interface AppManifest {
  name?: string;
  icon?: string;
  entryUrl?: string;
  placements?: string[];
  requiredScope?: string | null;
}

/** Mirrors `src/lib/kernel/app-nav.ts`'s `AppPlacement` — duplicated here (rather than imported) to keep this GitHub-specific module independent of kernel nav internals. */
const VALID_MANIFEST_PLACEMENTS = new Set(['launcher', 'home', 'auth-submenu']);

function isValidManifest(value: unknown): value is AppManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (v.icon !== undefined && typeof v.icon !== 'string') return false;
  if (v.entryUrl !== undefined && typeof v.entryUrl !== 'string') return false;
  if (v.requiredScope !== undefined && v.requiredScope !== null && typeof v.requiredScope !== 'string') return false;
  if (v.placements !== undefined) {
    if (!Array.isArray(v.placements)) return false;
    if (!v.placements.every((p) => typeof p === 'string' && VALID_MANIFEST_PLACEMENTS.has(p))) return false;
  }
  return true;
}

interface GitHubContentsResponse {
  content: string;
  encoding: string;
}

/**
 * Best-effort read of `imajin.app.json` from the app's own repo at
 * `apps.provision` time (#2425) — nav metadata (name/icon/entryUrl/
 * placements/requiredScope) an extracted app can publish about itself so
 * `registerApp` doesn't have to fall back to defaults for every third-party
 * app. The repo is created PRIVATE (see `createRepoFromTemplate`), so this
 * always requires an installation token — unlike the anonymous-first
 * repo-existence check above. The caller passes in the token (see
 * `provision.ts`'s use of {@link tryGetInstallationToken}) rather than this
 * function minting its own, so a single token is reused for the whole
 * provisioning run.
 *
 * Never throws: returns `null` when the credential is unsealed, the file
 * doesn't exist (a template that hasn't adopted the manifest convention
 * yet), or its contents don't parse/validate. A missing/invalid manifest is
 * NOT a provisioning failure — same degrade-don't-fail posture as
 * `tryGetInstallationToken`/`sealDeploySecrets`'s caller in `provision.ts`.
 */
export async function fetchAppManifest(slug: string, token: string | null): Promise<AppManifest | null> {
  if (token === null) return null;
  try {
    const res = await callGitHubApi<GitHubContentsResponse>({
      method: 'GET',
      path: `/repos/${PROVISIONING_ORG}/${slug}/contents/imajin.app.json`,
      token,
    });
    if (res.status !== 200 || res.data?.encoding !== 'base64') return null;

    const decoded = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(decoded);
    if (!isValidManifest(parsed)) {
      log.warn({ slug }, 'apps.provision: imajin.app.json failed validation, using defaults');
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn({ err: String(err), slug }, 'apps.provision: manifest read failed (non-fatal, using defaults)');
    return null;
  }
}

/**
 * Encrypt `plaintext` with libsodium's anonymous sealed box against
 * `repo`'s Actions public key, and PUT it as the named Actions secret.
 * `plaintext` is never logged; only the secret NAME is returned to the
 * caller for the `secretsSet` audit trail.
 */
export async function sealActionsSecret(repo: string, name: string, plaintext: string): Promise<void> {
  const token = await getInstallationToken();

  const keyResponse = await callGitHubApi<ActionsPublicKeyResponse>({
    method: 'GET',
    path: `/repos/${repo}/actions/secrets/public-key`,
    token,
  });
  if (keyResponse.status !== 200 || !keyResponse.data) {
    throw new Error(`apps.provision: failed to fetch Actions public key for '${repo}' (GitHub status ${keyResponse.status})`);
  }

  await sodium.ready;
  const publicKeyBytes = sodium.from_base64(keyResponse.data.key, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(plaintext);
  const sealed = sodium.crypto_box_seal(messageBytes, publicKeyBytes);
  const encryptedValue = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  const put = await callGitHubApi({
    method: 'PUT',
    path: `/repos/${repo}/actions/secrets/${name}`,
    token,
    body: { encrypted_value: encryptedValue, key_id: keyResponse.data.key_id },
  });
  if (put.status !== 201 && put.status !== 204) {
    throw new Error(`apps.provision: failed to seal Actions secret '${name}' into '${repo}' (GitHub status ${put.status})`);
  }

  log.info({ repo, name }, 'apps.provision: sealed Actions secret');
}
