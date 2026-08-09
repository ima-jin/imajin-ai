/**
 * GitHub corpus adapter (#1729).
 *
 * Fetches issues, pull requests, comments, and review comments from a GitHub
 * repository via the GraphQL API and normalizes them into `ThreadDocument`s.
 *
 * This adapter is standalone: it only depends on `../engine/types`, not on
 * the corpus engine itself (#1728), so the two can be built in parallel.
 */
import { graphql as octokitGraphql } from '@octokit/graphql';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterFetchOptions,
  AdapterSyncResult,
  CorpusAdapter,
  SourceType,
  ThreadComment,
  ThreadDocument,
  ThreadResolution,
  ThreadState,
} from '../engine/types';

// ─── GraphQL client ──────────────────────────────────────────────────────────

/**
 * Minimal shape we depend on from `@octokit/graphql`, so tests can inject a
 * fake client without needing to match the real library's types exactly.
 */
export type GraphqlClient = <TResponse>(query: string, parameters?: Record<string, unknown>) => Promise<TResponse>;

export interface GitHubAdapterOptions {
  /** Inject a fake/mocked client in tests instead of hitting the real API. */
  graphqlClient?: GraphqlClient;
}

const ISSUE_OR_PR_PAGE_SIZE = 25;
const COMMENT_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 50;
const DEFAULT_SYNC_LIMIT = 200;

// ─── Raw GraphQL response shapes ────────────────────────────────────────────

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

interface RawActor {
  login: string | null;
}

interface RawComment {
  id: string;
  author: RawActor | null;
  body: string;
  createdAt: string;
}

interface RawLabel {
  name: string;
}

interface RawReview {
  id: string;
  state: string;
  body: string;
  author: RawActor | null;
  submittedAt: string | null;
  comments: Connection<RawComment>;
}

// `itemTypes: [CLOSED_EVENT, CROSS_REFERENCED_EVENT]` in the query restricts
// the timeline to just these two shapes, so no catch-all arm is needed (one
// would also defeat the `__typename` narrowing below, since `string` is a
// supertype of the literal tags).
type RawTimelineItem =
  | {
      __typename: 'ClosedEvent';
      closer: { __typename: string; number?: number } | null;
    }
  | {
      __typename: 'CrossReferencedEvent';
      source: { __typename: string; number?: number } | null;
    };

interface RawIssueNode {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: RawActor | null;
  labels: { nodes: RawLabel[] };
  comments: Connection<RawComment>;
  timelineItems: { nodes: RawTimelineItem[] };
}

interface RawPullRequestNode {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: RawActor | null;
  labels: { nodes: RawLabel[] };
  comments: Connection<RawComment>;
  reviews: Connection<RawReview>;
}

interface IssuesQueryResult {
  repository: { issues: Connection<RawIssueNode> } | null;
}

interface PullRequestsQueryResult {
  repository: { pullRequests: Connection<RawPullRequestNode> } | null;
}

// ─── GraphQL queries ─────────────────────────────────────────────────────────

const ISSUES_QUERY = /* GraphQL */ `
  query CorpusGitHubIssues($owner: String!, $repo: String!, $first: Int!, $after: String, $since: DateTime) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: ASC }, filterBy: { since: $since }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          stateReason
          url
          createdAt
          updatedAt
          closedAt
          author { login }
          labels(first: 50) { nodes { name } }
          comments(first: ${COMMENT_PAGE_SIZE}) {
            pageInfo { hasNextPage endCursor }
            nodes { id author { login } body createdAt }
          }
          timelineItems(first: 50, itemTypes: [CLOSED_EVENT, CROSS_REFERENCED_EVENT]) {
            nodes {
              __typename
              ... on ClosedEvent {
                closer {
                  __typename
                  ... on PullRequest { number }
                }
              }
              ... on CrossReferencedEvent {
                source {
                  __typename
                  ... on PullRequest { number }
                  ... on Issue { number }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PULL_REQUESTS_QUERY = /* GraphQL */ `
  query CorpusGitHubPullRequests($owner: String!, $repo: String!, $first: Int!, $after: String, $direction: OrderDirection!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: $direction }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          isDraft
          url
          createdAt
          updatedAt
          closedAt
          mergedAt
          author { login }
          labels(first: 50) { nodes { name } }
          comments(first: ${COMMENT_PAGE_SIZE}) {
            pageInfo { hasNextPage endCursor }
            nodes { id author { login } body createdAt }
          }
          reviews(first: ${REVIEW_PAGE_SIZE}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              state
              body
              author { login }
              submittedAt
              comments(first: ${REVIEW_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes { id author { login } body createdAt }
              }
            }
          }
        }
      }
    }
  }
`;

// Node-scoped queries used to page past the first page of a nested
// connection (comments/reviews/review-comments) without re-fetching the
// whole issue/PR.
const NODE_COMMENTS_QUERY = /* GraphQL */ `
  query CorpusGitHubNodeComments($id: ID!, $after: String) {
    node(id: $id) {
      ... on Issue {
        comments(first: ${COMMENT_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login } body createdAt }
        }
      }
      ... on PullRequest {
        comments(first: ${COMMENT_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login } body createdAt }
        }
      }
    }
  }
`;

const PULL_REQUEST_REVIEWS_QUERY = /* GraphQL */ `
  query CorpusGitHubPullRequestReviews($id: ID!, $after: String) {
    node(id: $id) {
      ... on PullRequest {
        reviews(first: ${REVIEW_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            state
            body
            author { login }
            submittedAt
            comments(first: ${REVIEW_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes { id author { login } body createdAt }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_COMMENTS_QUERY = /* GraphQL */ `
  query CorpusGitHubReviewComments($id: ID!, $after: String) {
    node(id: $id) {
      ... on PullRequestReview {
        comments(first: ${REVIEW_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login } body createdAt }
        }
      }
    }
  }
`;

// ─── Token resolution ────────────────────────────────────────────────────────

/**
 * Resolves the GitHub token to authenticate with, in order of preference:
 * an explicit constructor argument, `GITHUB_TOKEN`/`GH_TOKEN` env vars, or
 * the token the `gh` CLI already has stored locally.
 */
export function resolveGitHubToken(explicitToken?: string): string {
  if (explicitToken) return explicitToken;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const ghCliToken = readGhCliToken();
  if (ghCliToken) return ghCliToken;
  throw new Error(
    'No GitHub token available. Pass one to the GitHubAdapter constructor, set GITHUB_TOKEN, or run `gh auth login`.',
  );
}

function readGhCliToken(): string | undefined {
  try {
    const hostsPath = join(homedir(), '.config', 'gh', 'hosts.yml');
    const contents = readFileSync(hostsPath, 'utf8');
    const match = /github\.com:[\s\S]*?oauth_token:\s*(\S+)/.exec(contents);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ─── Source parsing ──────────────────────────────────────────────────────────

/** Parses `"github:owner/repo"` into its `owner`/`repo` parts. */
export function parseGitHubSource(source: string): { owner: string; repo: string } {
  const match = /^github:([^/]+)\/(.+)$/.exec(source);
  if (!match) {
    throw new Error(`Invalid GitHub source "${source}". Expected format "github:owner/repo".`);
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function authorLogin(actor: RawActor | null): string {
  return actor?.login ?? 'ghost';
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('GitHubAdapter: fetch aborted');
  }
}

function byCreated(a: ThreadComment, b: ThreadComment): number {
  return new Date(a.created).getTime() - new Date(b.created).getTime();
}

function maxIso(a: string | null, b: string): string {
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

/** Extracts `#123`-style refs and bare URLs from a body of text. */
function extractBodyLinkedRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/#(\d+)/g)) {
    refs.add(`#${match[1]}`);
  }
  for (const match of body.matchAll(/https?:\/\/[^\s)]+/g)) {
    refs.add(match[0]);
  }
  return [...refs];
}

function extractTimelineLinkedRefs(items: RawTimelineItem[]): string[] {
  const refs: string[] = [];
  for (const item of items) {
    if (
      item.__typename === 'CrossReferencedEvent' &&
      item.source &&
      (item.source.__typename === 'PullRequest' || item.source.__typename === 'Issue') &&
      item.source.number != null
    ) {
      refs.push(`#${item.source.number}`);
    }
  }
  return refs;
}

function findClosingPullRequest(items: RawTimelineItem[]): string | undefined {
  for (const item of items) {
    if (item.__typename === 'ClosedEvent' && item.closer?.__typename === 'PullRequest' && item.closer.number != null) {
      return `#${item.closer.number}`;
    }
  }
  return undefined;
}

async function drainConnection<T>(
  initial: Connection<T>,
  fetchNext: (after: string) => Promise<Connection<T>>,
): Promise<T[]> {
  let all = initial.nodes;
  let pageInfo = initial.pageInfo;
  while (pageInfo.hasNextPage && pageInfo.endCursor) {
    const next = await fetchNext(pageInfo.endCursor);
    all = all.concat(next.nodes);
    pageInfo = next.pageInfo;
  }
  return all;
}

// ─── Resolution extraction ───────────────────────────────────────────────────

function hasDuplicateLabel(labels: string[]): boolean {
  return labels.some(label => label.toLowerCase() === 'duplicate');
}

function buildIssueResolution(node: RawIssueNode, labels: string[]): ThreadResolution | undefined {
  if (node.state !== 'CLOSED') return undefined;
  const fixedBy = findClosingPullRequest(node.timelineItems.nodes);
  if (hasDuplicateLabel(labels)) {
    return { kind: 'duplicate', fixedBy };
  }
  if (node.stateReason === 'NOT_PLANNED') {
    return { kind: 'wontfix', fixedBy };
  }
  // COMPLETED, or unset (issues closed before `stateReason` existed) both
  // default to "fixed" — the common case for closed issues.
  return { kind: 'fixed', fixedBy };
}

function buildPullRequestResolution(node: RawPullRequestNode, labels: string[]): ThreadResolution | undefined {
  if (hasDuplicateLabel(labels)) {
    return { kind: 'duplicate' };
  }
  if (node.state === 'MERGED') {
    return { kind: 'merged' };
  }
  return undefined;
}

// ─── Comment flattening ──────────────────────────────────────────────────────

function flattenIssueComments(comments: RawComment[]): ThreadComment[] {
  return comments
    .map((comment): ThreadComment => ({
      author: authorLogin(comment.author),
      body: comment.body,
      created: comment.createdAt,
      type: 'comment',
    }))
    .sort(byCreated);
}

function flattenPullRequestComments(comments: RawComment[], reviews: RawReview[]): ThreadComment[] {
  const flattened: ThreadComment[] = comments.map((comment): ThreadComment => ({
    author: authorLogin(comment.author),
    body: comment.body,
    created: comment.createdAt,
    type: 'comment',
  }));

  for (const review of reviews) {
    const created = review.submittedAt ?? review.comments.nodes[0]?.createdAt;
    const isMeaningfulAction = review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED';
    const hasBody = Boolean(review.body?.trim());
    if (created && (isMeaningfulAction || hasBody)) {
      flattened.push({
        author: authorLogin(review.author),
        body: review.body ?? '',
        created,
        type: 'review',
      });
    }
    for (const reviewComment of review.comments.nodes) {
      flattened.push({
        author: authorLogin(reviewComment.author),
        body: reviewComment.body,
        created: reviewComment.createdAt,
        type: 'review',
      });
    }
  }

  return flattened.sort(byCreated);
}

// ─── ThreadDocument construction ─────────────────────────────────────────────

function buildIssueDocument(owner: string, repo: string, node: RawIssueNode, allComments: RawComment[]): ThreadDocument {
  const labels = node.labels.nodes.map(label => label.name);
  const linkedRefs = [...new Set([...extractBodyLinkedRefs(node.body ?? ''), ...extractTimelineLinkedRefs(node.timelineItems.nodes)])];

  return {
    source: `github:${owner}/${repo}`,
    sourceType: 'github',
    id: String(node.number),
    type: 'issue',
    title: node.title,
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    labels,
    author: authorLogin(node.author),
    created: node.createdAt,
    closed: node.closedAt ?? undefined,
    updated: node.updatedAt,
    linkedRefs,
    body: node.body ?? '',
    comments: flattenIssueComments(allComments),
    resolution: buildIssueResolution(node, labels),
    url: node.url,
    meta: { updatedAt: node.updatedAt, etag: node.id },
  };
}

function pullRequestState(node: RawPullRequestNode): ThreadState {
  if (node.state === 'MERGED') return 'merged';
  if (node.state === 'CLOSED') return 'closed';
  return node.isDraft ? 'draft' : 'open';
}

function buildPullRequestDocument(
  owner: string,
  repo: string,
  node: RawPullRequestNode,
  allComments: RawComment[],
  allReviews: RawReview[],
): ThreadDocument {
  const labels = node.labels.nodes.map(label => label.name);

  return {
    source: `github:${owner}/${repo}`,
    sourceType: 'github',
    id: String(node.number),
    type: 'pr',
    title: node.title,
    state: pullRequestState(node),
    labels,
    author: authorLogin(node.author),
    created: node.createdAt,
    closed: node.closedAt ?? node.mergedAt ?? undefined,
    updated: node.updatedAt,
    linkedRefs: extractBodyLinkedRefs(node.body ?? ''),
    body: node.body ?? '',
    comments: flattenPullRequestComments(allComments, allReviews),
    resolution: buildPullRequestResolution(node, labels),
    url: node.url,
    meta: { updatedAt: node.updatedAt, etag: node.id },
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class GitHubAdapter implements CorpusAdapter {
  readonly sourceType: SourceType = 'github';
  private readonly graphqlClient: GraphqlClient;

  constructor(token?: string, options: GitHubAdapterOptions = {}) {
    if (options.graphqlClient) {
      this.graphqlClient = options.graphqlClient;
    } else {
      const resolvedToken = resolveGitHubToken(token);
      this.graphqlClient = octokitGraphql.defaults({
        headers: { authorization: `token ${resolvedToken}` },
      }) as GraphqlClient;
    }
  }

  async *fetch(source: string, options: AdapterFetchOptions = {}): AsyncIterable<ThreadDocument> {
    const { owner, repo } = parseGitHubSource(source);
    const limit = options.limit;
    let emitted = 0;

    for await (const doc of this.iterateIssues(owner, repo, { since: null, signal: options.signal })) {
      if (limit != null && emitted >= limit) return;
      yield doc;
      emitted++;
    }
    for await (const doc of this.iteratePullRequests(owner, repo, { direction: 'ASC', signal: options.signal })) {
      if (limit != null && emitted >= limit) return;
      yield doc;
      emitted++;
    }
  }

  async sync(source: string, cursor: string | null, options: AdapterFetchOptions = {}): Promise<AdapterSyncResult> {
    const { owner, repo } = parseGitHubSource(source);
    const limit = options.limit ?? DEFAULT_SYNC_LIMIT;
    const documents: ThreadDocument[] = [];
    let latestUpdatedAt = cursor;
    let hasMore = false;

    // Issues support a native `since` filter, so we can page ascending and
    // stop as soon as we've collected `limit` documents.
    for await (const doc of this.iterateIssues(owner, repo, { since: cursor, signal: options.signal })) {
      if (documents.length >= limit) {
        hasMore = true;
        break;
      }
      documents.push(doc);
      latestUpdatedAt = maxIso(latestUpdatedAt, doc.updated);
    }

    // Pull requests have no native `since` filter on this connection, so we
    // page newest-first and stop as soon as we cross the cursor boundary.
    if (documents.length < limit) {
      for await (const doc of this.iteratePullRequestsSince(owner, repo, cursor, options.signal)) {
        if (documents.length >= limit) {
          hasMore = true;
          break;
        }
        documents.push(doc);
        latestUpdatedAt = maxIso(latestUpdatedAt, doc.updated);
      }
    }

    return { documents, cursor: latestUpdatedAt, hasMore };
  }

  // ── Issues ──────────────────────────────────────────────────────────────

  private async *iterateIssues(
    owner: string,
    repo: string,
    opts: { since: string | null; signal?: AbortSignal },
  ): AsyncGenerator<ThreadDocument> {
    let after: string | null = null;
    do {
      checkAborted(opts.signal);
      const issues = await this.fetchIssuePage(owner, repo, after, opts.since);
      for (const node of issues.nodes) {
        const comments = await this.collectNodeComments(node.id, node.comments);
        yield buildIssueDocument(owner, repo, node, comments);
      }
      after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
    } while (after);
  }

  private async fetchIssuePage(
    owner: string,
    repo: string,
    after: string | null,
    since: string | null,
  ): Promise<Connection<RawIssueNode>> {
    const page = await this.graphqlClient<IssuesQueryResult>(ISSUES_QUERY, {
      owner,
      repo,
      first: ISSUE_OR_PR_PAGE_SIZE,
      after,
      since,
    });
    return page.repository?.issues ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  // ── Pull requests ───────────────────────────────────────────────────────

  private async *iteratePullRequests(
    owner: string,
    repo: string,
    opts: { direction: 'ASC' | 'DESC'; signal?: AbortSignal },
  ): AsyncGenerator<ThreadDocument> {
    let after: string | null = null;
    do {
      checkAborted(opts.signal);
      const page = await this.fetchPullRequestPage(owner, repo, after, opts.direction);
      for (const node of page.nodes) {
        const [comments, reviews] = await Promise.all([
          this.collectNodeComments(node.id, node.comments),
          this.collectPullRequestReviews(node),
        ]);
        yield buildPullRequestDocument(owner, repo, node, comments, reviews);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }

  /**
   * Pages pull requests newest-updated-first, stopping as soon as a node's
   * `updatedAt` is not newer than `cursor` — everything after that point is
   * guaranteed to be older, so there is no need to keep paging.
   */
  private async *iteratePullRequestsSince(
    owner: string,
    repo: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadDocument> {
    let after: string | null = null;
    do {
      checkAborted(signal);
      const page = await this.fetchPullRequestPage(owner, repo, after, 'DESC');
      for (const node of page.nodes) {
        if (cursor && node.updatedAt <= cursor) return;
        const [comments, reviews] = await Promise.all([
          this.collectNodeComments(node.id, node.comments),
          this.collectPullRequestReviews(node),
        ]);
        yield buildPullRequestDocument(owner, repo, node, comments, reviews);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }

  private async fetchPullRequestPage(
    owner: string,
    repo: string,
    after: string | null,
    direction: 'ASC' | 'DESC',
  ): Promise<Connection<RawPullRequestNode>> {
    const page = await this.graphqlClient<PullRequestsQueryResult>(PULL_REQUESTS_QUERY, {
      owner,
      repo,
      first: ISSUE_OR_PR_PAGE_SIZE,
      after,
      direction,
    });
    return page.repository?.pullRequests ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  // ── Nested pagination ───────────────────────────────────────────────────

  private async collectNodeComments(nodeId: string, initial: Connection<RawComment>): Promise<RawComment[]> {
    return drainConnection(initial, async after => {
      const page = await this.graphqlClient<{ node: { comments: Connection<RawComment> } | null }>(NODE_COMMENTS_QUERY, {
        id: nodeId,
        after,
      });
      return page.node?.comments ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    });
  }

  private async collectPullRequestReviews(node: RawPullRequestNode): Promise<RawReview[]> {
    const reviews = await drainConnection(node.reviews, async after => {
      const page = await this.graphqlClient<{ node: { reviews: Connection<RawReview> } | null }>(
        PULL_REQUEST_REVIEWS_QUERY,
        { id: node.id, after },
      );
      return page.node?.reviews ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    });

    return Promise.all(
      reviews.map(async review => ({
        ...review,
        comments: {
          nodes: await drainConnection(review.comments, async after => {
            const page = await this.graphqlClient<{ node: { comments: Connection<RawComment> } | null }>(
              REVIEW_COMMENTS_QUERY,
              { id: review.id, after },
            );
            return page.node?.comments ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
          }),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })),
    );
  }
}
