import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const updater = join(root, 'deploy/infer-passthrough/update.sh');
const git = (cwd, ...args) => execFileSync('git', ['-c', `safe.directory=${root}`, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let dir;
let state;
let repo;
let previous;
let env;
let sha;
let logFile;

function stub(name, script) {
  writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\nset -eu\n${script}\n`, { mode: 0o755 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infer-update-'));
  state = join(dir, 'state');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(state, 'releases'), { recursive: true });
  previous = join(state, 'previous');
  mkdirSync(previous);
  symlinkSync(previous, join(state, 'current'));
  const origin = join(dir, 'origin');
  // Local-only fixtures inherit actual commit objects, requiring no git identity.
  execFileSync('git', ['-c', `safe.directory=${root}`, 'clone', '--bare', '--shared', root, origin], { stdio: 'pipe' });
  for (const ref of git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags').split('\n').filter(Boolean)) {
    git(origin, 'update-ref', '-d', ref);
  }
  sha = git(root, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/heads/main', sha);
  for (const tag of ['v0.8.9', 'v0.8.10', 'v0.9.0-rc.1', 'unrelated']) {
    git(origin, 'update-ref', `refs/tags/${tag}`, sha);
  }
  repo = join(dir, 'repo');
  execFileSync('git', ['clone', '--bare', '--shared', origin, repo], { stdio: 'pipe' });
  logFile = join(dir, 'calls');
  writeFileSync(logFile, '');
  env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    INFER_UPDATE_STATE_DIR: state,
    INFER_UPDATE_REPO: repo,
    INFER_UPDATE_USER: 'fixture-user',
    CALLS: logFile,
    PREVIOUS: previous,
    FAIL_PHASE: '',
  };
  stub('runuser', 'printf "runuser %s\\n" "$*" >> "$CALLS"\nshift 3\nexec "$@"');
  stub('pnpm', 'printf "pnpm %s\\n" "$*" >> "$CALLS"\n[[ "$FAIL_PHASE" != install && ( "$FAIL_PHASE" != build || "$3" != exec ) ]]');
  stub('systemd-run', 'printf "candidate %s\\n" "$*" >> "$CALLS"\n[[ "$FAIL_PHASE" != launch ]]');
  stub('systemctl', `printf "systemctl %s\\n" "$*" >> "$CALLS"
[[ "$FAIL_PHASE" != inactive || "$1" != is-active ]] || exit 1
if [[ "$FAIL_PHASE" == restart && "$1" == restart && "$(readlink -f "$INFER_UPDATE_STATE_DIR/current")" != "$PREVIOUS" ]]; then exit 1; fi`);
  stub('node', `
if [[ "$1" == */production-deployment.mjs ]]; then
  printf "production %s\\n" "$2" >> "$CALLS"
  [[ "$FAIL_PHASE" != unapproved ]] || exit 1
  [[ "$FAIL_PHASE" != api ]] || exit 2
  exit 0
fi
printf "health %s\\n" "$*" >> "$CALLS"
[[ "$FAIL_PHASE" != preflight || "\${2:-}" != 8788 ]] || exit 1
if [[ "$FAIL_PHASE" == live && "\${2:-}" == 8787 && "$(readlink -f "$INFER_UPDATE_STATE_DIR/current")" != "$PREVIOUS" ]]; then exit 1; fi
`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args = []) {
  return spawnSync('bash', [updater, ...args], { env, encoding: 'utf8', timeout: 30_000 });
}
const calls = () => readFileSync(logFile, 'utf8');
const current = () => realpathSync(join(state, 'current'));

function unrelatedCommit() {
  return execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: `${git(repo, 'cat-file', 'commit', sha).replace(/^parent .*\n/gm, '')}\nfixture variant\n`,
    encoding: 'utf8',
  }).trim();
}

describe('pull-based passthrough release updater (#3041, #3082)', () => {
  it('refuses tags not on freshly fetched origin/main before calling the API or staging code', () => {
    const variant = unrelatedCommit();
    for (const tag of ['v0.8.9', 'v0.8.10']) {
      // Copy fixture objects without authoring commits or configuring identity.
      execFileSync('git', ['-C', join(dir, 'origin'), 'fetch', repo, `${variant}:refs/tags/${tag}`, '--force'], { stdio: 'pipe' });
    }
    // Simulate remote tags before the updater fetch.
    for (const tag of ['v0.8.9', 'v0.8.10']) git(repo, 'update-ref', `refs/tags/${tag}`, variant);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('tag commit is not on origin/main');
    expect(calls()).toContain('+refs/heads/main:refs/remotes/origin/main');
    expect(calls()).not.toMatch(/production |worktree add|pnpm |candidate |systemctl /);
    expect(current()).toBe(previous);
  });

  it.each(['unapproved', 'api'])('refuses %s production verification without installing/restarting or moving current', (phase) => {
    env.FAIL_PHASE = phase;
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('no verified successful production deployment');
    expect(calls()).toContain(`production ${sha}`);
    expect(calls()).not.toMatch(/worktree add|pnpm |candidate |systemctl /);
    expect(current()).toBe(previous);
  });

  it('does not let a stray high off-main tag pin out a later authorized release', () => {
    const variant = unrelatedCommit();
    execFileSync('git', ['-C', join(dir, 'origin'), 'fetch', repo, `${variant}:refs/tags/v99.0.0`], { stdio: 'pipe' });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('refusing v99.0.0: tag commit is not on origin/main');
    expect(result.stdout).toContain('approved v0.8.10');
    expect(current()).toBe(join(state, 'releases', sha));
  });

  it('dry-run also refuses a release that has not passed the production gate', () => {
    env.FAIL_PHASE = 'unapproved';
    expect(run(['--dry-run']).status).not.toBe(0);
    expect(current()).toBe(previous);
    expect(calls()).not.toMatch(/pnpm |candidate |systemctl /);
  });
  it('dry-run fetches and picks the numerically newest stable tag without install/restart/switch', () => {
    const result = run(['--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('latest release v0.8.10');
    expect(result.stdout).toContain('dry-run: stage v0.8.10');
    expect(calls()).toContain('fetch --tags origin');
    expect(calls()).not.toMatch(/pnpm |systemctl |candidate |health /);
    expect(current()).toBe(previous);
  });

  it('rolls back even if the live restart itself fails', () => {
    env.FAIL_PHASE = 'restart';
    const result = run();
    expect(result.status).not.toBe(0);
    expect(current()).toBe(previous);
    expect(calls().match(/restart infer-passthrough.service/g)).toHaveLength(2);
    expect(result.stdout).toContain('rollback healthy');
  });

  it('fails closed when the remote has no stable release tags', () => {
    const origin = join(dir, 'origin');
    for (const cwd of [repo, origin]) {
      for (const ref of git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/tags').split('\n').filter(Boolean)) {
        git(cwd, 'update-ref', '-d', ref);
      }
    }
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('no stable release tag found');
    expect(current()).toBe(previous);
    expect(calls()).not.toMatch(/pnpm |systemctl /);
  });

  it('refuses overlapping updates', () => {
    stub('flock', 'exit 1');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('another updater holds the lock');
    expect(calls()).toBe('');
  });

  it('rejects a candidate directory containing another commit', () => {
    const candidate = join(state, 'releases', sha);
    // Copy existing commit metadata unchanged; no fixture identity/config needed.
    // A parentless variant also works when CI has only fetched one commit.
    const variant = unrelatedCommit();
    git(repo, 'worktree', 'add', '--detach', candidate, variant);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('candidate SHA mismatch');
    expect(current()).toBe(previous);
    expect(calls()).not.toContain('pnpm ');
  });

  it('preflights the candidate before switching and then checks live mints', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(current()).toBe(join(state, 'releases', sha));
    const trace = calls();
    expect(trace.indexOf(`production ${sha}`)).toBeLessThan(trace.indexOf('worktree add'));
    expect(trace).toContain('install --frozen-lockfile --ignore-scripts');
    expect(trace).toContain('turbo run build --filter=@imajin/auth');
    expect(trace).toContain('--uid=fixture-user');
    expect(trace).toContain('--property=EnvironmentFile=/etc/imajin/infer-passthrough.env');
    expect(trace).toContain('INFER_PROXY_HOST=127.0.0.1 INFER_PROXY_PORT=8788');
    expect(trace.indexOf('check-health.mjs 8788')).toBeLessThan(trace.indexOf('restart infer-passthrough.service'));
    expect(trace.indexOf('restart infer-passthrough.service')).toBeLessThan(trace.indexOf('check-health.mjs 8787'));
    expect(result.stdout).toContain('all route mints healthy');
    expect(run().status).toBe(0);
    expect(calls().match(/restart infer-passthrough.service/g)).toHaveLength(1);
  });

  it.each(['install', 'build', 'launch', 'preflight', 'inactive'])('keeps previous checkout and never restarts live on failed %s', (phase) => {
    env.FAIL_PHASE = phase;
    const result = run();
    expect(result.status).not.toBe(0);
    expect(current()).toBe(previous);
    expect(calls()).not.toContain('restart infer-passthrough.service');
    expect(result.stdout).toContain('previous checkout unchanged');
  });

  it('rolls back the checkout and restarts/checks the old version when live health fails', () => {
    env.FAIL_PHASE = 'live';
    const result = run();
    expect(result.status).not.toBe(0);
    expect(current()).toBe(previous);
    expect(calls().match(/restart infer-passthrough.service/g)).toHaveLength(2);
    expect(calls().match(/check-health.mjs 8787/g)).toHaveLength(2);
    expect(result.stdout).toContain('rollback healthy');
  });

  it('rejects dirty staged code without installing or changing live', () => {
    const candidate = join(state, 'releases', sha);
    git(repo, 'worktree', 'add', '--detach', candidate, sha);
    writeFileSync(join(candidate, 'unexpected-local-file'), 'fixture');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('candidate has local changes');
    expect(current()).toBe(previous);
    expect(calls()).not.toContain('pnpm ');
  });

  it.each([
    ['INFER_UPDATE_PORT', '0'], ['INFER_UPDATE_PORT', '65536'],
    ['INFER_UPDATE_PORT', 'not-a-port'], ['INFER_UPDATE_CANDIDATE_PORT', '8787'],
  ])('rejects invalid or colliding ports (%s=%s)', (key, value) => {
    env[key] = value;
    expect(run().status).toBe(2);
    expect(calls()).toBe('');
  });

  it('rejects unknown flags before running any commands', () => {
    expect(run(['--unknown']).status).toBe(2);
    expect(calls()).toBe('');
  });

  it('release check invokes the shared health route checker without fetching or deploying', () => {
    expect(run(['--check']).status).toBe(0);
    expect(calls()).toContain('check-health.mjs 8787');
    expect(calls()).not.toMatch(/runuser|systemctl|pnpm/);
  });
});
