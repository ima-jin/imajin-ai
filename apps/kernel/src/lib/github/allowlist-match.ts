/**
 * GitHub connector disclosure allowlist \u2014 pure matchers (#1373).
 *
 * These are the I/O-free predicates/filters used to enforce the disclosure
 * allowlist server-side. They live apart from `allowlist.ts` (which reads the
 * manifest asset and therefore pulls the DB/media graph) so they can be unit
 * tested in isolation.
 *
 * See `allowlist.ts` for the disclosure-vs-capability framing: the OAuth `repo`
 * scope is the capability bound; this allowlist only narrows what the connector
 * discloses to the MCP client.
 */

/**
 * The parsed disclosure allowlist:
 *   - `null`  \u21d2 allow-all (field empty/absent, or manifest unreadable).
 *   - `Set`   \u21d2 only the listed org logins / repo full names may be disclosed.
 * Entries are normalized to lowercase for case-insensitive matching.
 */
export type ReadAllowlist = ReadonlySet<string> | null;

/**
 * Whether a repo `owner/name` may be disclosed under `allowlist`.
 * Allowed when: allow-all (`null`), OR the exact `owner/name` is listed, OR the
 * bare `owner` is listed (an org-level grant covers all of its repos).
 * Fail-closed: a malformed/ownerless full name is dropped.
 */
export function isRepoAllowed(fullName: string, allowlist: ReadAllowlist): boolean {
  if (allowlist === null) return true;
  const normalized = fullName.trim().toLowerCase();
  const owner = normalized.split('/')[0] ?? '';
  if (owner.length === 0 || !normalized.includes('/')) return false; // ambiguous → drop
  return allowlist.has(normalized) || allowlist.has(owner);
}

/**
 * Whether an org `login` may be disclosed under `allowlist`.
 * Allowed when: allow-all (`null`), OR the `login` is listed directly, OR any
 * entry is `login/...` (the org owns a listed repo, so disclose the org so the
 * owner can navigate to it).
 * Fail-closed: an empty/undetermined login is dropped.
 */
export function isOrgAllowed(login: string, allowlist: ReadAllowlist): boolean {
  if (allowlist === null) return true;
  const normalized = login.trim().toLowerCase();
  if (normalized.length === 0) return false; // ambiguous → drop
  if (allowlist.has(normalized)) return true;
  const repoPrefix = `${normalized}/`;
  for (const entry of allowlist) {
    if (entry.startsWith(repoPrefix)) return true;
  }
  return false;
}

/** Filter a list of repos to the ones disclosable under `allowlist`. */
export function filterRepos<T extends { full_name: string }>(repos: readonly T[], allowlist: ReadAllowlist): T[] {
  if (allowlist === null) return [...repos];
  return repos.filter((r) => isRepoAllowed(r.full_name, allowlist));
}

/** Filter a list of orgs to the ones disclosable under `allowlist`. */
export function filterOrgs<T extends { login: string }>(orgs: readonly T[], allowlist: ReadAllowlist): T[] {
  if (allowlist === null) return [...orgs];
  return orgs.filter((o) => isOrgAllowed(o.login, allowlist));
}
