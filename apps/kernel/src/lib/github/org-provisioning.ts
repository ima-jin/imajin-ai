/**
 * GitHub org-scoped provisioning (#2375) — the credential + REST calls
 * `apps.provision` uses to create a first-party app's repo and seal its
 * deploy secrets. Deliberately separate from `./connector.ts`: that module
 * is a PER-DID OAuth/PAT connector for issue/PR automation on behalf of a
 * human, gated by `channel_links` + the confirm rail. This module has no
 * per-DID concept at all — it is the KERNEL's own org-wide credential,
 * ruled by Ryan 2026-09-24 (#2375): "the kernel does it with an org-scoped
 * credential; no org-admin grant to `warp-factories[bot]`".
 *
 * ## Credential custody
 * The org-scoped GitHub token is a single, kernel-wide vault field
 * ({@link GITHUB_ORG_CREDENTIAL_FIELD}), sealed ONCE by the operator via
 * the existing generic `POST /api/vault/set` route with
 * `custodyScheme: 'delegation-grant'` (v2 self-granted to the node,
 * #2311's "v2 grant shape") — no new sealing route. See
 * `docs/REGISTRATION.md` for the exact scopes the token needs: repo
 * creation from a template (`repo`, or fine-grained Administration:write
 * on the org), Actions-secrets write on the created repo, and
 * `read:packages` (the SAME token is reused as the sealed
 * `GITHUB_PACKAGES_TOKEN` Actions secret — see #2375's PR description for
 * why one sufficiently-scoped token was chosen over two).
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
 * No secret value (org credential, minted private key, or GitHub Packages
 * token) is ever logged.
 */
import { createRequire } from 'node:module';
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
 * Vault field holding the kernel-wide, org-scoped GitHub credential
 * (#2375). Sealed once by the operator via `POST /api/vault/set`
 * (`custodyScheme: 'delegation-grant'`) — see this module's docblock.
 */
export const GITHUB_ORG_CREDENTIAL_FIELD = 'github-org-provisioning';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/** Thrown when the org-scoped credential has never been sealed. */
export class OrgCredentialMissingError extends Error {
  constructor() {
    super(
      `${GITHUB_ORG_CREDENTIAL_FIELD} is not sealed — an operator must seal an org-scoped ` +
      `GitHub credential via POST /api/vault/set before apps.provision can create repos ` +
      `or seal deploy secrets (see docs/REGISTRATION.md)`,
    );
    this.name = 'OrgCredentialMissingError';
  }
}

/**
 * Load the org-scoped GitHub credential. Throws {@link OrgCredentialMissingError}
 * if it has never been sealed. Never logged.
 */
export async function loadOrgCredential(): Promise<string> {
  const token = await loadAndUnseal(GITHUB_ORG_CREDENTIAL_FIELD);
  if (token === undefined) {
    throw new OrgCredentialMissingError();
  }
  return token;
}

interface GitHubApiOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

/**
 * Call the GitHub REST API with the org-scoped credential. Returns
 * `{ status, data }` rather than throwing on non-2xx, so callers can
 * branch on 404 (e.g. "repo does not exist yet") without exception-driven
 * control flow. The token is only ever used in the Authorization header —
 * never logged.
 */
async function callGitHubApi<T = unknown>(opts: Readonly<GitHubApiOptions>): Promise<{ status: number; data: T | null }> {
  const url = opts.path.startsWith('http') ? opts.path : `${GITHUB_API_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'imajin-kernel-apps-provision/1.0',
  };

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

/**
 * Idempotent repo provisioning (#2375 acceptance: "repo creation must be
 * idempotent/skippable when the repo exists"). Checks for an existing
 * `ima-jin/{slug}` repo first; only calls the template-generate endpoint
 * when none exists. Fails closed on any other GitHub error (rate limit,
 * bad credential, etc.).
 */
export async function ensureRepoFromTemplate(
  slug: string,
  template: string = DEFAULT_APP_TEMPLATE,
): Promise<EnsureRepoResult> {
  const token = await loadOrgCredential();

  const existing = await callGitHubApi<GitHubRepoResponse>({
    method: 'GET',
    path: `/repos/${PROVISIONING_ORG}/${slug}`,
    token,
  });
  if (existing.status === 200 && existing.data) {
    log.info({ slug, repo: existing.data.full_name }, 'apps.provision: repo already exists — skipping creation');
    return { repoUrl: existing.data.html_url, created: false };
  }
  if (existing.status !== 404) {
    throw new Error(`apps.provision: failed to check for existing repo '${slug}' (GitHub status ${existing.status})`);
  }

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

interface ActionsPublicKeyResponse {
  key_id: string;
  key: string;
}

/**
 * Encrypt `plaintext` with libsodium's anonymous sealed box against
 * `repo`'s Actions public key, and PUT it as the named Actions secret.
 * `plaintext` is never logged; only the secret NAME is returned to the
 * caller for the `secretsSet` audit trail.
 */
export async function sealActionsSecret(repo: string, name: string, plaintext: string): Promise<void> {
  const token = await loadOrgCredential();

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
