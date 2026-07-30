/**
 * GitHub connector disclosure allowlist (#1373).
 *
 * ── Disclosure, NOT capability ────────────────────────────────────────────────
 * The connector uses OAuth2 authorization-code (#1340), so the OAuth app's
 * granted `repo` scope is the CAPABILITY bound at GitHub — that is what actually
 * limits what the token can touch. This allowlist is a DISCLOSURE bound layered
 * on top: it decides which orgs/repos the discovery tools (github_list_orgs /
 * github_list_repos / github_get_repo) are allowed to reveal to the MCP client.
 * It never widens capability and it is not a security boundary against a
 * misbehaving token — it only narrows what the model gets to see.
 *
 * ── Where it lives ────────────────────────────────────────────────────────────
 * The allowlist is an OPTIONAL `allowlist:` field on the `github:read` grant in
 * the connector scope-manifest (same grant-by-edit / revoke-by-delete control
 * plane as the write scopes, #1204). Empty or absent ⇒ allow-all (opt-in
 * tightening). Each entry is either an org login (`ima-jin`) or a repo full name
 * (`ima-jin/imajin-ai`).
 *
 * ── Fail-closed on ambiguity ──────────────────────────────────────────────────
 * When an allowlist is present and an org/repo owner cannot be determined, the
 * entry is DROPPED (never default-included). Filtering happens server-side,
 * AFTER the GitHub call (for lists) or BEFORE the fetch (for github_get_repo),
 * so excluded names never cross the wire to the model.
 */
import { createLogger } from '@imajin/logger';
import { readAssetTextContent } from '@/src/lib/media/queries';
import { parseFrontmatter } from '@/src/lib/media/frontmatter';
import { findGitHubManifestAsset } from './scope-manifest';
import type { ReadAllowlist } from './allowlist-match';

// Re-export the pure matchers/filters so `./allowlist` remains the single import
// surface for the connector (the matchers live in `allowlist-match.ts` so they
// can be unit tested without loading the DB/media graph this module pulls in).
export type { ReadAllowlist } from './allowlist-match';
export { isRepoAllowed, isOrgAllowed, filterRepos, filterOrgs } from './allowlist-match';

const log = createLogger('kernel');

/** The manifest scope whose grant carries the disclosure allowlist. */
const READ_SCOPE_KEY = 'github:read';

/** Lowercase + trim a raw allowlist entry; drop empties. */
function normalizeEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * Read the disclosure allowlist off the `github:read` grant in ownerDid's
 * GitHub scope-manifest.
 *
 * Returns `null` (allow-all) when the manifest is missing/unreadable or the
 * `allowlist` field is empty/absent. Returns a lowercased `Set` otherwise.
 * Never throws — the OAuth `repo` scope remains the capability bound, so a
 * read failure degrades to the documented allow-all default rather than
 * blocking discovery.
 */
export async function readReadAllowlist(ownerDid: string): Promise<ReadAllowlist> {
  let content: string;
  try {
    const asset = await findGitHubManifestAsset(ownerDid);
    if (!asset) return null;
    content = await readAssetTextContent(asset);
  } catch (err) {
    log.warn({ err: String(err), ownerDid }, 'github allowlist: manifest unreadable — defaulting to allow-all');
    return null;
  }

  const { data } = parseFrontmatter(content);
  const readGrant = data[READ_SCOPE_KEY];
  if (readGrant === null || typeof readGrant !== 'object') return null;

  const entries = normalizeEntries((readGrant as Record<string, unknown>).allowlist);
  return entries.length > 0 ? new Set(entries) : null;
}
