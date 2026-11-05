import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHECK_NAME = 'Check Migrations (vs main)';
const GIT_OPTIONS = { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 };

function git(args, cwd) {
  return execFileSync('git', args, { ...GIT_OPTIONS, cwd });
}

function pathsAt(ref, cwd) {
  return git(['ls-tree', '-r', '--name-only', '-z', ref, '--', 'migrations/'], cwd)
    .toString('utf8').split('\0').filter(Boolean);
}

function writeBlob(directory, ref, path, cwd) {
  // Git paths are data, never shell arguments, symlinks, or executable PR code.
  if (!path.startsWith('migrations/') || path.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe migration path: ${path}`);
  }
  const destination = join(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, git(['show', `${ref}:${path}`], cwd));
}

export function checkPullMigrations({ main, head, cwd = process.cwd() }) {
  const changes = git([
    'diff', '--no-renames', '--name-only', '-z', `${main}...${head}`, '--', 'migrations/',
  ], cwd).toString('utf8').split('\0').filter(Boolean);
  if (changes.length === 0) return null;

  const directory = mkdtempSync(join(tmpdir(), 'migration-recheck-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'apps'));
    mkdirSync(join(directory, 'migrations'));
    // Always execute main's checker unchanged, not the PR's scripts or SQL.
    writeFileSync(join(directory, 'scripts/check-migrations.sh'),
      git(['show', `${main}:scripts/check-migrations.sh`], cwd));
    for (const path of pathsAt(main, cwd)) writeBlob(directory, main, path, cwd);
    const headPaths = new Set(pathsAt(head, cwd));
    for (const path of changes) {
      if (headPaths.has(path)) writeBlob(directory, head, path, cwd);
      else rmSync(join(directory, path), { force: true });
    }
    const result = spawnSync('bash', ['scripts/check-migrations.sh'], {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: GIT_OPTIONS.maxBuffer,
      timeout: 60_000,
      // Do not pass the runner's token/secrets into the checker process.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LC_ALL: 'C.UTF-8' },
    });
    if (result.error || result.signal) {
      throw new Error(`Migration checker did not complete: ${result.error?.message ?? result.signal}`);
    }
    return {
      conclusion: result.status === 0 ? 'success' : 'failure',
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkOutput(result) {
  return {
    title: result.conclusion === 'success' ? 'Migrations valid against main' : 'Migration check failed against main',
    summary: 'Main’s unchanged scripts/check-migrations.sh, with this PR’s migration changes overlaid. See the checker output below.',
    // Check output supports 65,535 bytes; retain its final error lines if large.
    text: result.output.slice(-15_000),
  };
}

export async function recheckOpenPulls({
  github, context, core, cwd = process.cwd(), check = checkPullMigrations,
  fetch = (args) => git(args, cwd),
}) {
  const { owner, repo } = context.repo;
  fetch(['fetch', 'origin', 'main']);
  const main = fetch(['rev-parse', 'origin/main']).toString().trim();
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', base: 'main', per_page: 100,
  });
  let failed = false;
  for (const pull of pulls) {
    if (pull.head.repo?.full_name !== `${owner}/${repo}`) {
      core.info(`Skipping fork/deleted head for PR #${pull.number}: no writable same-repo head.`);
      continue;
    }
    try {
      fetch(['fetch', 'origin', pull.head.sha]);
      const result = check({ main, head: pull.head.sha, cwd });
      if (!result) {
        core.info(`Skipping PR #${pull.number}: no migration changes.`);
        continue;
      }
      await github.rest.checks.create({
        owner, repo, head_sha: pull.head.sha, name: CHECK_NAME,
        status: 'completed', conclusion: result.conclusion,
        details_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
        output: checkOutput(result),
      });
      core.info(`PR #${pull.number} (${pull.head.sha}): ${result.conclusion}\n${result.output}`);
    } catch (error) {
      // A single unreadable PR or denied write must not prevent other reports.
      core.error(`PR #${pull.number}: ${error.message}`);
      failed = true;
    }
  }
  if (failed) core.setFailed('One or more migration rechecks could not be reported; see the per-PR errors.');
}
