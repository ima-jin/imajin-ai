import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  collectDoneCheck, linkedIssues, parsePr, QUESTION, renderMarkdown, run,
} from '../review/done-check.mjs';
import {
  createGithub, createGraphql, ISSUE_QUERY, PR_QUERY, resolveGh,
} from '../review/github.mjs';

const REPO = 'ima-jin/imajin-ai';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/done-check/replay.json', import.meta.url), 'utf8'));
const ref = (number, repo = REPO) => ({ number, repo });
const nodeRef = (number, repo = REPO) => ({ number, repository: { nameWithOwner: repo } });

function recordedGraphql(query, variables) {
  const kind = query === PR_QUERY ? 'pr' : 'issue';
  const record = fixture.records.find(record =>
    record.kind === kind && JSON.stringify(record.variables) === JSON.stringify(variables));
  if (!record) throw new Error(`Unrecorded request: ${JSON.stringify(variables)}`);
  return structuredClone(record.response.data.repository);
}

function issue(number, overrides = {}) {
  return {
    ...nodeRef(number), title: 'ordinary task', body: '', comments: [], parent: null,
    author: { login: 'reviewer' }, createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T01:00:00Z', url: `https://github.com/${REPO}/issues/${number}`,
    ...overrides,
  };
}

function fakeApi(body, issues, closingIssuesReferences = []) {
  return {
    pullRequest: vi.fn(() => ({ body, closingIssuesReferences })),
    issue: vi.fn(({ number, repo }) => {
      const found = issues.find(item =>
        item.number === number && item.repository.nameWithOwner.toLowerCase() === repo.toLowerCase());
      if (!found) throw new Error('Missing fake issue');
      return found;
    }),
  };
}

describe('recorded GraphQL replay (unmodified native hierarchy, 2026-10-19)', () => {
  it('surfaces #2411’s full ruling and the actual #2241 epic for PR #2413', () => {
    const result = collectDoneCheck(ref(2413), createGithub(recordedGraphql));
    expect(result.chains).toEqual([[`${REPO}#2411`, `${REPO}#2241`]]);
    expect(result.lines.find(line => line.issue === `${REPO}#2411`)).toMatchObject({
      kind: 'ruling', source: 'body', author: 'imajin-jin', line: 3,
      date: '2026-09-27T23:08:58Z',
    });
    expect(result.lines[0].text).toContain('Not a /jin copy-paste into `.env.local`');
    expect(result.lines.some(line => line.kind === 'outcome' && line.issue === `${REPO}#2241`)).toBe(true);
    expect(result.lines.some(line => line.kind === 'acceptance')).toBe(true);
  });

  it('does not invent a cross-repo parent for the currently unparented dykil#5', () => {
    const result = collectDoneCheck(ref(6, 'ima-jin/dykil'), createGithub(recordedGraphql));
    expect(result.chains).toEqual([['ima-jin/dykil#5']]);
    expect(result.lines.map(line => line.issue)).toEqual(['ima-jin/dykil#5']);
    expect(result.lines[0].text).toContain('Ruled c + b');
  });

  it('replays the intended dykil#5/#2411/#2370 chain with explicitly synthetic parent edges', () => {
    // Content is recorded; ONLY these two relationships are synthetic.
    const api = createGithub((query, variables) => {
      const data = recordedGraphql(query, variables);
      if (data.issue?.number === 5) data.issue.parent = nodeRef(2411);
      if (data.issue?.number === 2411) data.issue.parent = nodeRef(2370);
      return data;
    });
    const result = collectDoneCheck(ref(6, 'ima-jin/dykil'), api);
    expect(result.chains[0]).toEqual(['ima-jin/dykil#5', `${REPO}#2411`, `${REPO}#2370`]);
    expect(result.lines.find(line => line.issue === `${REPO}#2411`).text)
      .toContain('Not a /jin copy-paste into `.env.local`');
    expect(result.lines.find(line => line.kind === 'outcome').text)
      .toContain('without a shell');
  });
});

describe('reference resolution', () => {
  it('accepts only a safe owner/repo#positive-integer PR argument', () => {
    expect(parsePr(`${REPO}#2413`)).toEqual(ref(2413));
    for (const value of ['', '#1', `${REPO}#0`, `${REPO}#1;ls`, `${REPO}#99999999999999999999`]) {
      expect(parsePr(value)).toBeNull();
    }
  });

  it('resolves local, cross-repo, URL, Addresses, lists and multiple clauses', () => {
    expect(linkedIssues([
      'Closes #1, #2 and ima-jin/dykil#5. Addresses: #3',
      'Fixes https://github.com/ima-jin/imajin-ai/issues/2411',
      'Resolved #4',
      'Refs #88',
      '```md', 'Closes #99', '```',
      '~~~', 'Addresses #100', '~~~',
    ].join('\n'), REPO)).toEqual([
      ref(1), ref(2), ref(5, 'ima-jin/dykil'), ref(3), ref(2411), ref(4),
    ]);
  });

  it('deduplicates body/GraphQL links and caches shared parents across issues', () => {
    const api = fakeApi('Closes #1, #2. Addresses #1', [
      issue(1, { parent: nodeRef(3) }), issue(2, { parent: nodeRef(3) }),
      issue(3, { body: 'OUTCOME · parent\nruled a: shared ruling' }),
    ], [nodeRef(1)]);
    const result = collectDoneCheck(ref(10), api);
    expect(api.issue).toHaveBeenCalledTimes(3);
    expect(result.chains).toHaveLength(2);
    expect(result.lines).toHaveLength(2);
  });

  it('follows an explicit cross-repo close and native cross-repo parent', () => {
    const api = fakeApi(`Closes ${REPO}#1`, [
      issue(1, { parent: nodeRef(2, 'ima-jin/dykil') }),
      issue(2, { ...nodeRef(2, 'ima-jin/dykil'), body: 'OUTCOME · cross repo' }),
    ]);
    expect(collectDoneCheck(ref(6, 'ima-jin/dykil'), api).chains[0])
      .toEqual([`${REPO}#1`, 'ima-jin/dykil#2']);
  });
});

describe('lines, provenance and advisory behavior', () => {
  it('collects every ruled-letter body/comment line, including Markdown emphasis', () => {
    const api = fakeApi('Addresses #1', [issue(1, {
      body: '**DECISION ruled c:** first\nRuled **b**: second\nruled by Ryan: not a letter\nruled banana: not a letter',
      comments: [{
        body: 'context\nruled d: later\nDECISION ruled a: also later',
        author: null, createdAt: '2026-10-19T02:00:00Z',
        url: `https://github.com/${REPO}/issues/1#issuecomment-123`,
      }],
    })]);
    const result = collectDoneCheck(ref(10), api);
    expect(result.lines).toHaveLength(4);
    expect(result.lines[2]).toMatchObject({
      source: 'comment', author: '[deleted]', line: 2, date: '2026-10-19T02:00:00Z',
    });
    const markdown = renderMarkdown(result);
    expect(markdown).toContain(`${REPO}#1 comment:2 · @[deleted] · 2026-10-19T02:00:00Z`);
    expect(markdown).toContain(QUESTION);
    expect(markdown).toContain('REQUEST CHANGES');
    expect(markdown).toContain('genuine design fork');
  });

  it('takes only the first OUTCOME line and bounds acceptance at the next peer heading', () => {
    const api = fakeApi('Closes #1', [issue(1, {
      body: 'OUTCOME · first\n\nOUTCOME · not first\n## Acceptance criteria\n- [ ] one\n### Nested\nTwo\n## Other\nNot acceptance',
    })]);
    const result = collectDoneCheck(ref(10), api);
    expect(result.lines.map(line => line.text)).toEqual(['OUTCOME · first', '- [ ] one', 'Two']);
  });

  it('warns but exits zero when the epic lacks its first-line OUTCOME', () => {
    const api = fakeApi('Closes #1', [
      issue(1, { parent: nodeRef(2) }),
      issue(2, { body: 'intro\nOUTCOME · too late\n## Acceptance\nShip it' }),
    ]);
    const result = run([`${REPO}#10`, '--json'], () => api);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).warnings).toEqual([
      `epic ${REPO}#2 has no OUTCOME line — add before merging children`,
    ]);
    expect(JSON.parse(result.output).lines[0].kind).toBe('acceptance');
  });

  it('warns on a directly linked epic without OUTCOME, but ordinary no-ruling PRs pass unchanged', () => {
    const epic = collectDoneCheck(ref(10), fakeApi('Closes #1', [issue(1, { title: 'Epic: needs outcome' })]));
    expect(epic.warnings).toHaveLength(1);
    const ordinary = collectDoneCheck(ref(10), fakeApi('Closes #1', [issue(1)]));
    expect(ordinary.lines).toEqual([]);
    expect(ordinary.warnings).toEqual([]);
    expect(collectDoneCheck(ref(10), fakeApi('No issue links', [])).lines).toEqual([]);
  });

  it('stops cyclic parent data with an advisory instead of looping', () => {
    const result = collectDoneCheck(ref(10), fakeApi('Closes #1', [
      issue(1, { parent: nodeRef(2) }), issue(2, { parent: nodeRef(1) }),
    ]));
    expect(result.chains[0]).toHaveLength(2);
    expect(result.warnings[0]).toContain('native parent cycle');
  });

  it('renders source HTML as text, not executable markup', () => {
    const result = collectDoneCheck(ref(10), fakeApi('Closes #1', [
      issue(1, { body: 'OUTCOME · <app>/claim & safe' }),
    ]));
    expect(renderMarkdown(result)).toContain('&lt;app&gt;/claim &amp; safe');
  });

  it('returns usage at zero without calling APIs and fails nonzero only on API errors', () => {
    const getApi = vi.fn();
    expect(run([], getApi).code).toBe(0);
    expect(JSON.parse(run(['--json'], getApi).output).warnings[0]).toContain('Usage:');
    expect(getApi).not.toHaveBeenCalled();
    const failure = run([`${REPO}#10`], () => { throw new Error('API unavailable'); });
    expect(failure.code).toBe(1);
    expect(failure.error).toContain('API unavailable');
    expect(run([`${REPO}#10`], () => fakeApi('no links', [])).output).toContain('## Done-check lines');
  });
});

describe('gh API transport and pagination (no live network)', () => {
  it.each([
    [PR_QUERY, 'pullRequest', 'closingIssuesReferences'],
    [ISSUE_QUERY, 'issue', 'comments'],
  ])('paginates %s without truncating nodes', (query, field, connection) => {
    const graphql = vi.fn((_query, { after }) => ({
      [field]: {
        [connection]: {
          nodes: [after ? 'second page ruling' : 'first page'],
          pageInfo: { hasNextPage: !after, endCursor: after ? null : 'cursor-1' },
        },
      },
    }));
    const api = createGithub(graphql);
    expect(api[field](ref(1))[connection]).toEqual(['first page', 'second page ruling']);
    expect(graphql).toHaveBeenLastCalledWith(query, {
      owner: 'ima-jin', repo: 'imajin-ai', number: 1, after: 'cursor-1',
    });
  });

  it('fails closed on missing issues and invalid/repeated pagination cursors', () => {
    expect(() => createGithub(() => ({ issue: null })).issue(ref(1))).toThrow('could not resolve');
    for (const endCursor of [null, 'repeated']) {
      const api = createGithub(() => ({
        issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } },
      }));
      expect(() => api.issue(ref(1))).toThrow('invalid pagination cursor');
    }
  });

  it('uses caller gh auth and argument arrays, omitting undefined cursors and credentials', () => {
    const execute = vi.fn(() => JSON.stringify({ data: { repository: { issue: {} } } }));
    createGraphql('/usr/bin/gh', execute)(ISSUE_QUERY, {
      owner: 'ima-jin', repo: 'dykil', number: 5, after: undefined,
    });
    const [binary, args, options] = execute.mock.calls[0];
    expect(binary).toBe('/usr/bin/gh');
    expect(args).toEqual([
      'api', 'graphql', '-f', `query=${ISSUE_QUERY}`,
      '-F', 'owner=ima-jin', '-F', 'repo=dykil', '-F', 'number=5',
    ]);
    expect(options).not.toHaveProperty('shell');
    expect(options).not.toHaveProperty('env');
  });

  it('reports transport, JSON, GraphQL and inaccessible repository failures without leaking stderr', () => {
    for (const response of ['not JSON', '{"errors":[{"message":"denied"}]}', '{"data":{"repository":null}}']) {
      expect(() => createGraphql('/usr/bin/gh', () => response)(PR_QUERY, {})).toThrow();
    }
    const fail = () => { throw new Error('private stderr must not leak'); };
    expect(() => createGraphql('/usr/bin/gh', fail)(PR_QUERY, {})).toThrow('check gh auth');
    expect(() => resolveGh({ PATH: '' })).toThrow('gh was not found');
  });
});
