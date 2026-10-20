import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const IDENTITY = 'number repository { nameWithOwner }';
const PAGE = 'pageInfo { hasNextPage endCursor }';
const SOURCE = 'body author { login } createdAt updatedAt url';

export const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      body
      closingIssuesReferences(first:100,after:$after) { nodes { ${IDENTITY} } ${PAGE} }
    }
  }
}`;

export const ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) {
    issue(number:$number) {
      ${IDENTITY} title ${SOURCE}
      parent { ${IDENTITY} }
      comments(first:100,after:$after) { nodes { ${SOURCE} } ${PAGE} }
    }
  }
}`;

/** Resolve gh once; execFile receives an absolute executable and separate args. */
export function resolveGh(env = process.env) {
  const names = process.platform === 'win32' ? ['gh.exe'] : ['gh'];
  const directories = (env.PATH ?? '').split(delimiter).filter(isAbsolute);
  const candidates = directories.flatMap(directory => names.map(name => join(directory, name)));
  const binary = candidates.find(candidate => existsSync(candidate));
  if (!binary) throw new Error('GitHub API unavailable: gh was not found on PATH.');
  return binary;
}

export function createGraphql(binary, execute = execFileSync) {
  return (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined) args.push('-F', `${key}=${value}`);
    }
    let result;
    try {
      result = JSON.parse(execute(binary, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      }));
    } catch {
      // Do not dump child-process args, environment or arbitrary API stderr.
      throw new Error('GitHub API request failed; check gh auth and repository access.');
    }
    if (result.errors?.length || !result.data?.repository) {
      throw new Error('GitHub GraphQL returned errors or an inaccessible repository.');
    }
    return result.data.repository;
  };
}

/** Every connection page is fetched, including comments beyond the first 100. */
export function createGithub(graphql) {
  function fetchPages(query, ref, field, connection) {
    const [owner, repo] = ref.repo.split('/');
    let after;
    let entity;
    const nodes = [];
    const cursors = new Set();
    do {
      const page = graphql(query, { owner, repo, number: ref.number, after })[field];
      if (!page) throw new Error(`GitHub API could not resolve ${ref.repo}#${ref.number}.`);
      entity = page;
      nodes.push(...page[connection].nodes);
      const info = page[connection].pageInfo;
      after = info.hasNextPage ? info.endCursor : undefined;
      if (info.hasNextPage && (!after || cursors.has(after))) {
        throw new Error('GitHub API returned an invalid pagination cursor.');
      }
      cursors.add(after);
    } while (after);
    return { ...entity, [connection]: nodes };
  }
  return {
    pullRequest: ref => fetchPages(PR_QUERY, ref, 'pullRequest', 'closingIssuesReferences'),
    issue: ref => fetchPages(ISSUE_QUERY, ref, 'issue', 'comments'),
  };
}
