/**
 * GitHub connector entity shapes and pagination primitives — I/O free (#1528).
 *
 * These live apart from `connector.ts` for the same reason `allowlist-match.ts`
 * does: `connector.ts` pulls in the DB, the vault, and the bus, so anything that
 * imports it needs that whole world stood up. The types below, the label/PR
 * discriminators, and the `Link`-header arithmetic are pure, and both the MCP
 * tool layer and its tests want them without the connector's dependencies.
 *
 * `connector.ts` re-exports everything here, so `./connector` remains a valid
 * single import surface for existing call sites.
 */

// ── Entity shapes ────────────────────────────────────────────────────────────

/** A GitHub account reference as it appears on issues, PRs, and comments. */
export interface GitHubUserRef {
  login: string;
}

/**
 * A label. GitHub returns objects on the REST endpoints used here, but the
 * string form is still legal on some payload shapes, so the field type below
 * admits both and `labelNames()` normalises.
 */
export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string | null;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  state: string;
  due_on?: string | null;
}

/** Normalise the mixed `labels` shape to plain names. */
export function labelNames(labels: ReadonlyArray<GitHubLabel | string> | undefined): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/**
 * An issue as returned by `/issues` and `/search/issues`.
 *
 * Fields added in #1528 are optional so that partial payloads (and older
 * fixtures) still typecheck; the tool layer defaults them.
 *
 * `pull_request` is the discriminator GitHub uses to mix PRs into the issues
 * endpoint — present ⇒ this "issue" is really a PR. `isPullRequest()` is the
 * only place that knowledge is encoded.
 */
export interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string | null;
  user: GitHubUserRef | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  labels?: Array<GitHubLabel | string>;
  assignees?: GitHubUserRef[] | null;
  milestone?: GitHubMilestone | null;
  comments?: number;
  state_reason?: string | null;
  locked?: boolean;
  draft?: boolean;
  author_association?: string;
  /** Present only when the row is actually a pull request. */
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null };
  /** Present on `/search/issues` results: `https://api.github.com/repos/owner/name`. */
  repository_url?: string;
}

/** True when an `/issues` row is really a pull request. */
export function isPullRequest(issue: Readonly<GitHubIssue>): boolean {
  return issue.pull_request !== undefined && issue.pull_request !== null;
}

/** What kind of row a caller wants back from the mixed `/issues` endpoint. */
export type GitHubIssueType = 'issue' | 'pr' | 'all';

export interface GitHubComment {
  id: number;
  html_url: string;
  body: string;
  user: GitHubUserRef | null;
  created_at: string;
  updated_at?: string;
  author_association?: string;
}

/** One side of a pull request (head or base). */
export interface GitHubPullRef {
  ref: string;
  sha?: string;
  label?: string;
  repo?: { full_name: string } | null;
}

/**
 * A pull request from `/pulls`.
 *
 * Note the list-vs-detail asymmetry in GitHub's own API: `mergeable`,
 * `mergeable_state`, and the diff counters are only populated on the single-PR
 * endpoint, so they are optional here and simply absent from list rows.
 */
export interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string | null;
  user: GitHubUserRef | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: GitHubPullRef;
  base?: GitHubPullRef;
  requested_reviewers?: GitHubUserRef[] | null;
  labels?: Array<GitHubLabel | string>;
  assignees?: GitHubUserRef[] | null;
  milestone?: GitHubMilestone | null;
  comments?: number;
  review_comments?: number;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  author_association?: string;
}

// ── Pagination primitives ────────────────────────────────────────────────────

/** Default number of items a list verb returns when the caller says nothing. */
export const DEFAULT_LIST_LIMIT = 100;

/**
 * Ceiling on `limit`. Above this a listing stops being context an agent can
 * reason about and starts being a token bill; callers that need more should
 * narrow the query (state/labels/since) or use `searchIssues`.
 */
export const MAX_LIST_LIMIT = 300;

/** GitHub's own per-page maximum for the endpoints used here. */
const MAX_PER_PAGE = 100;

/**
 * Hard stop on pages walked per list call. `limit`/`MAX_PER_PAGE` alone is not a
 * bound once a post-fetch predicate is involved (a repo whose first 500 `/issues`
 * rows are all PRs would otherwise walk forever), so cap the walk and report the
 * result as incomplete rather than looping.
 */
export const MAX_PAGES_PER_LIST = 12;

/** Clamp a caller-supplied limit into [1, MAX_LIST_LIMIT], defaulting when absent. */
export function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIST_LIMIT);
}

/**
 * Extract the `rel="next"` URL from a `Link` header, or null when this is the
 * last page. Defensive about a missing `headers` object so a fetch impl that
 * omits them degrades to "no more pages" instead of throwing.
 */
export function parseNextLink(headers: Headers | undefined): string | null {
  const raw = headers?.get?.('link') ?? null;
  if (raw === null || raw.length === 0) return null;

  for (const part of raw.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Append `per_page` to a path that may or may not already carry a query string. */
export function withPerPage(path: string, limit: number): string {
  const perPage = Math.min(MAX_PER_PAGE, Math.max(limit, 1));
  return `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}`;
}

/**
 * A bounded, incompleteness-reporting page walk.
 *
 * `hasMore` is the whole point: a caller must be able to tell "these are all of
 * them" apart from "these are the first N of an unknown number", so it is set
 * whenever GitHub still had a next page or the page ceiling was hit.
 */
export interface PaginatedCollection<T> {
  items: T[];
  /** True when results were left behind — by `limit` or by the page ceiling. */
  hasMore: boolean;
  /** Pages actually fetched (useful for logging / rate-limit reasoning). */
  pages: number;
}

/** Shared envelope for every paginated read verb (#1528). */
export interface GitHubListResult<T> {
  items: T[];
  /** True when GitHub had more results than `limit` allowed through. */
  hasMore: boolean;
  /** The effective (clamped) limit that produced `items`. */
  limit: number;
}
