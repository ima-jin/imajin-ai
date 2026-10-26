/**
 * Release close-out for tag-release.yml (#3093). Uses only its GITHUB_TOKEN.
 * The Issues API includes PRs and accepts issues:write for milestone changes.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function version(tag) {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
}

export function nextPatchMilestone(tag, milestones) {
  const current = version(tag);
  if (!current) throw new Error('Expected a vX.Y.Z release tag');
  return milestones
    .filter((milestone) => {
      const candidate = version(milestone.title);
      return milestone.state === 'open'
        && candidate?.[1] === current[1] && candidate[2] === current[2]
        && BigInt(candidate[3]) > BigInt(current[3]);
    })
    .sort((a, b) => {
      const left = BigInt(version(a.title)[3]);
      const right = BigInt(version(b.title)[3]);
      return left < right ? -1 : Number(left > right);
    })[0];
}

function runGh(args) {
  // tag-release.yml uses Ubuntu's system-installed CLI, never a PATH override.
  return execFileSync('/usr/bin/gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function closeOutRelease({ tag, repo, gh = runGh, log = console.log }) {
  if (!version(tag)) throw new Error('Expected a vX.Y.Z release tag');
  if (!/^[\w-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Expected owner/repo');

  try {
    gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName']);
    log(`Release ${tag} already exists — skipping creation.`);
  } catch (error) {
    // Do not turn permission, transport or server failures into create attempts.
    if (!/^release not found\r?$/m.test(String(error.stderr ?? ''))) throw error;
    gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--generate-notes']);
    log(`Created Release ${tag} with generated notes.`);
  }

  const base = `repos/${repo}`;
  const milestones = JSON.parse(gh([
    'api', `${base}/milestones?state=all&per_page=100`, '--paginate', '--slurp',
  ])).flat();
  const source = milestones.find((milestone) => milestone.title === tag);
  if (!source || source.state === 'closed') {
    log(`Milestone ${tag} absent or already closed — skipping close-out.`);
    return;
  }
  const next = nextPatchMilestone(tag, milestones);
  if (!next) {
    log(`::warning::No next open patch milestone for ${tag}; leaving it open.`);
    return;
  }

  // Snapshot ALL pages before moving anything: mutating while paging skips items.
  const items = JSON.parse(gh([
    'api', `${base}/issues?milestone=${source.number}&state=open&per_page=100`,
    '--paginate', '--slurp',
  ])).flat();
  for (const item of items) {
    gh(['api', '--method', 'PATCH', `${base}/issues/${item.number}`,
      '-F', `milestone=${next.number}`]);
    log(`Moved #${item.number} from ${tag} to ${next.title}.`);
  }
  gh(['api', '--method', 'PATCH', `${base}/milestones/${source.number}`,
    '-f', 'state=closed']);
  log(`Closed milestone ${tag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  closeOutRelease({ tag: process.env.TAG, repo: process.env.GH_REPO });
}
