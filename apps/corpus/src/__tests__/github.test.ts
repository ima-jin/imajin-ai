import { describe, expect, it, vi } from 'vitest';
import { GitHubAdapter, parseGitHubSource, type GraphqlClient } from '../adapters/github';
import type { ThreadDocument } from '../engine/types';

// ─── Mock GraphQL client ─────────────────────────────────────────────────────

type Handler = (variables: Record<string, unknown>) => unknown;

/**
 * Builds a fake `@octokit/graphql`-shaped client that dispatches to a
 * per-operation handler based on the GraphQL operation name, so tests never
 * touch the real GitHub API.
 */
function mockClient(handlers: Record<string, Handler>): GraphqlClient {
  return vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
    const match = /query\s+(\w+)/.exec(query);
    const operation = match?.[1];
    const handler = operation ? handlers[operation] : undefined;
    if (!handler) {
      throw new Error(`mockClient: no handler for operation "${operation}"`);
    }
    return handler(variables);
  }) as unknown as GraphqlClient;
}

const emptyConnection = { nodes: [] as unknown[], pageInfo: { hasNextPage: false, endCursor: null } };

function emptyIssues() {
  return { repository: { issues: emptyConnection } };
}

function emptyPullRequests() {
  return { repository: { pullRequests: emptyConnection } };
}

async function collect(iterable: AsyncIterable<ThreadDocument>): Promise<ThreadDocument[]> {
  const docs: ThreadDocument[] = [];
  for await (const doc of iterable) docs.push(doc);
  return docs;
}

// ─── Fixture builders ────────────────────────────────────────────────────────

function comment(id: string, login: string, body: string, createdAt: string) {
  return { id, author: { login }, body, createdAt };
}

function issueNode(overrides: Record<string, unknown> = {}) {
  const number = (overrides.number as number | undefined) ?? 1;
  return {
    id: 'ISSUE_1',
    number,
    title: 'Something is broken',
    body: 'It broke.',
    state: 'OPEN',
    stateReason: null,
    url: `https://github.com/ima-jin/imajin-ai/issues/${number}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    closedAt: null,
    author: { login: 'alice' },
    labels: { nodes: [] },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function pullRequestNode(overrides: Record<string, unknown> = {}) {
  const number = (overrides.number as number | undefined) ?? 100;
  return {
    id: 'PR_1',
    number,
    title: 'Fix the thing',
    body: 'Fixes #1',
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/ima-jin/imajin-ai/pull/${number}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    author: { login: 'carol' },
    labels: { nodes: [] },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ...overrides,
  };
}

// ─── Source parsing ──────────────────────────────────────────────────────────

describe('parseGitHubSource', () => {
  it('parses owner/repo from a github: source string', () => {
    expect(parseGitHubSource('github:ima-jin/imajin-ai')).toEqual({ owner: 'ima-jin', repo: 'imajin-ai' });
  });

  it('throws on a source string without a github: prefix', () => {
    expect(() => parseGitHubSource('gitlab:ima-jin/imajin-ai')).toThrow(/Invalid GitHub source/);
  });
});

// ─── fetch(): issues ─────────────────────────────────────────────────────────

describe('GitHubAdapter#fetch — issues', () => {
  it('produces a valid ThreadDocument for a closed issue with a linked closing PR', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: {
          issues: {
            nodes: [
              issueNode({
                number: 42,
                title: 'Bug: crashes on startup',
                body: 'Crashes every time. See #10.',
                state: 'CLOSED',
                stateReason: 'COMPLETED',
                closedAt: '2024-02-01T00:00:00Z',
                updatedAt: '2024-02-01T00:00:00Z',
                comments: {
                  nodes: [comment('C1', 'bob', 'Same here', '2024-01-15T00:00:00Z')],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                timelineItems: {
                  nodes: [
                    {
                      __typename: 'ClosedEvent',
                      closer: { __typename: 'PullRequest', number: 55 },
                    },
                  ],
                },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const docs = await collect(adapter.fetch('github:ima-jin/imajin-ai'));

    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(doc.source).toBe('github:ima-jin/imajin-ai');
    expect(doc.sourceType).toBe('github');
    expect(doc.id).toBe('42');
    expect(doc.type).toBe('issue');
    expect(doc.state).toBe('closed');
    expect(doc.title).toBe('Bug: crashes on startup');
    expect(doc.author).toBe('alice');
    expect(doc.linkedRefs).toContain('#10');
    expect(doc.url).toBe('https://github.com/ima-jin/imajin-ai/issues/42');
    expect(doc.comments).toEqual([{ author: 'bob', body: 'Same here', created: '2024-01-15T00:00:00Z', type: 'comment' }]);
    expect(doc.resolution).toEqual({ kind: 'fixed', fixedBy: '#55' });
  });

  it('falls back to "ghost" for a deleted author', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: {
          issues: {
            nodes: [issueNode({ author: null })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.author).toBe('ghost');
  });
});

// ─── fetch(): pull requests ──────────────────────────────────────────────────

describe('GitHubAdapter#fetch — pull requests', () => {
  it('produces a ThreadDocument for a merged PR with reviews and review comments, flattened chronologically', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: emptyIssues,
      CorpusGitHubPullRequests: () => ({
        repository: {
          pullRequests: {
            nodes: [
              pullRequestNode({
                number: 7,
                title: 'Add feature X',
                state: 'MERGED',
                mergedAt: '2024-03-03T00:00:00Z',
                updatedAt: '2024-03-03T00:00:00Z',
                comments: {
                  nodes: [comment('IC1', 'dave', 'Looks good so far', '2024-03-01T00:00:00Z')],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviews: {
                  nodes: [
                    {
                      id: 'REV1',
                      state: 'APPROVED',
                      body: 'LGTM',
                      author: { login: 'erin' },
                      submittedAt: '2024-03-02T12:00:00Z',
                      comments: {
                        nodes: [comment('RC1', 'erin', 'nit: rename this', '2024-03-02T00:00:00Z')],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequestReviews: () => ({ node: { reviews: emptyConnection } }),
      CorpusGitHubReviewComments: () => ({ node: { comments: emptyConnection } }),
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));

    expect(doc.type).toBe('pr');
    expect(doc.id).toBe('7');
    expect(doc.state).toBe('merged');
    expect(doc.resolution).toEqual({ kind: 'merged' });
    expect(doc.url).toBe('https://github.com/ima-jin/imajin-ai/pull/7');

    // Chronological order: issue-style comment, then the code review comment,
    // then the review approval itself.
    expect(doc.comments.map(c => ({ author: c.author, type: c.type }))).toEqual([
      { author: 'dave', type: 'comment' },
      { author: 'erin', type: 'review' },
      { author: 'erin', type: 'review' },
    ]);
    expect(doc.comments.map(c => c.created)).toEqual([
      '2024-03-01T00:00:00Z',
      '2024-03-02T00:00:00Z',
      '2024-03-02T12:00:00Z',
    ]);
  });

  it('maps a draft PR to state "draft"', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: emptyIssues,
      CorpusGitHubPullRequests: () => ({
        repository: {
          pullRequests: {
            nodes: [pullRequestNode({ isDraft: true, state: 'OPEN' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequestReviews: () => ({ node: { reviews: emptyConnection } }),
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.state).toBe('draft');
  });
});

// ─── Resolution extraction ───────────────────────────────────────────────────

describe('resolution extraction', () => {
  it('maps an issue closed as not planned to "wontfix"', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: {
          issues: {
            nodes: [issueNode({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.resolution).toEqual({ kind: 'wontfix', fixedBy: undefined });
  });

  it('maps an issue with a "duplicate" label to "duplicate", overriding stateReason', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: {
          issues: {
            nodes: [
              issueNode({
                state: 'CLOSED',
                stateReason: 'COMPLETED',
                labels: { nodes: [{ name: 'Duplicate' }] },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.resolution?.kind).toBe('duplicate');
  });

  it('leaves resolution undefined for an open issue', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: { issues: { nodes: [issueNode({ state: 'OPEN' })], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.resolution).toBeUndefined();
  });

  it('leaves resolution undefined for a closed-but-not-merged PR without a duplicate label', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: emptyIssues,
      CorpusGitHubPullRequests: () => ({
        repository: {
          pullRequests: { nodes: [pullRequestNode({ state: 'CLOSED' })], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
      CorpusGitHubPullRequestReviews: () => ({ node: { reviews: emptyConnection } }),
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.resolution).toBeUndefined();
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('pagination', () => {
  it('follows cursor-based pagination across multiple pages of issues', async () => {
    const issuesHandler = vi.fn((variables: Record<string, unknown>) => {
      if (!variables.after) {
        return {
          repository: {
            issues: {
              nodes: [issueNode({ number: 1, title: 'First' })],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        };
      }
      expect(variables.after).toBe('cursor-1');
      return {
        repository: {
          issues: {
            nodes: [issueNode({ number: 2, title: 'Second' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const graphqlClient = mockClient({
      CorpusGitHubIssues: issuesHandler,
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const docs = await collect(adapter.fetch('github:ima-jin/imajin-ai'));

    expect(docs.map(d => d.title)).toEqual(['First', 'Second']);
    expect(issuesHandler).toHaveBeenCalledTimes(2);
  });

  it('pages past the first page of nested issue comments', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: () => ({
        repository: {
          issues: {
            nodes: [
              issueNode({
                comments: {
                  nodes: [comment('C1', 'bob', 'first page', '2024-01-01T00:00:00Z')],
                  pageInfo: { hasNextPage: true, endCursor: 'comments-cursor-1' },
                },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      CorpusGitHubPullRequests: emptyPullRequests,
      CorpusGitHubNodeComments: (variables: Record<string, unknown>) => {
        expect(variables.after).toBe('comments-cursor-1');
        return {
          node: {
            comments: {
              nodes: [comment('C2', 'bob', 'second page', '2024-01-02T00:00:00Z')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const [doc] = await collect(adapter.fetch('github:ima-jin/imajin-ai'));
    expect(doc.comments.map(c => c.body)).toEqual(['first page', 'second page']);
  });
});

// ─── sync() ───────────────────────────────────────────────────────────────────

describe('GitHubAdapter#sync', () => {
  it('passes the cursor through as `since` and returns only updated issues', async () => {
    const cursor = '2024-02-01T00:00:00Z';
    const issuesHandler = vi.fn((variables: Record<string, unknown>) => {
      expect(variables.since).toBe(cursor);
      return {
        repository: {
          issues: {
            nodes: [issueNode({ number: 9, updatedAt: '2024-02-15T00:00:00Z' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const graphqlClient = mockClient({
      CorpusGitHubIssues: issuesHandler,
      CorpusGitHubPullRequests: emptyPullRequests,
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const result = await adapter.sync('github:ima-jin/imajin-ai', cursor);

    expect(issuesHandler).toHaveBeenCalled();
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toBe('9');
    expect(result.cursor).toBe('2024-02-15T00:00:00Z');
    expect(result.hasMore).toBe(false);
  });

  it('stops paging pull requests once nodes fall behind the cursor', async () => {
    const cursor = '2024-02-01T00:00:00Z';
    const pullRequestsHandler = vi.fn(() => ({
      repository: {
        pullRequests: {
          nodes: [
            pullRequestNode({ number: 20, updatedAt: '2024-02-10T00:00:00Z' }),
            pullRequestNode({ number: 19, updatedAt: '2024-01-01T00:00:00Z' }), // older than cursor
          ],
          pageInfo: { hasNextPage: true, endCursor: 'should-not-be-followed' },
        },
      },
    }));

    const graphqlClient = mockClient({
      CorpusGitHubIssues: emptyIssues,
      CorpusGitHubPullRequests: pullRequestsHandler,
      CorpusGitHubPullRequestReviews: () => ({ node: { reviews: emptyConnection } }),
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const result = await adapter.sync('github:ima-jin/imajin-ai', cursor);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toBe('20');
    // Only one page fetched — the second (older) node ended iteration before
    // the "should-not-be-followed" cursor was ever used.
    expect(pullRequestsHandler).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe('2024-02-10T00:00:00Z');
  });

  it('starts from a null cursor on first sync and returns every open thread', async () => {
    const graphqlClient = mockClient({
      CorpusGitHubIssues: (variables: Record<string, unknown>) => {
        expect(variables.since).toBeNull();
        return {
          repository: {
            issues: { nodes: [issueNode({ number: 1 })], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      },
      CorpusGitHubPullRequests: () => ({
        repository: {
          pullRequests: { nodes: [pullRequestNode({ number: 2 })], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
      CorpusGitHubPullRequestReviews: () => ({ node: { reviews: emptyConnection } }),
    });

    const adapter = new GitHubAdapter(undefined, { graphqlClient });
    const result = await adapter.sync('github:ima-jin/imajin-ai', null);

    expect(result.documents.map(d => d.id).sort()).toEqual(['1', '2']);
  });
});
