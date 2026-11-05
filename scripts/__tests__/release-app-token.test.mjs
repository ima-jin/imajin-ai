import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import YAML from 'yaml';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = YAML.parse(read('.github/workflows/release.yml'));
const steps = workflow.jobs.release.steps;
const guard = steps.find((step) => step.name === 'Require release App configuration');
const mint = steps.find((step) => step.id === 'release-app');
const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
const pr = steps.find((step) => step.id === 'pr');
const appToken = '${{ steps.release-app.outputs.token }}';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe('release App configuration guard', () => {
  it('checks configuration before minting, checkout, bumping or branching', () => {
    expect(guard.env).toEqual({
      RELEASE_APP_ID: '${{ vars.RELEASE_APP_ID }}',
      RELEASE_APP_PRIVATE_KEY: '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    });
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(mint));
    expect(steps.indexOf(mint)).toBeLessThan(steps.indexOf(checkout));
    expect(steps.indexOf(checkout)).toBeLessThan(steps.findIndex((step) => step.id === 'bump'));
    expect(guard.run).not.toContain('${{');
  });

  // These are inert sentinels, never an App id, key or token.
  it.each([
    ['', '', ['RELEASE_APP_ID (Actions variable)', 'RELEASE_APP_PRIVATE_KEY (Actions secret)']],
    ['', 'inert-key-sentinel', ['RELEASE_APP_ID (Actions variable)']],
    ['inert-id-sentinel', '', ['RELEASE_APP_PRIVATE_KEY (Actions secret)']],
    ['inert-id-sentinel', 'inert-key-sentinel', []],
  ])('fails closed for configuration %# without disclosing input', (id, key, missing) => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-c', guard.run], {
      encoding: 'utf8',
      cwd: fileURLToPath(root),
      env: { ...process.env, RELEASE_APP_ID: id, RELEASE_APP_PRIVATE_KEY: key },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(missing.length ? 1 : 0);
    for (const name of missing) expect(result.stdout).toContain(`::error::${name} is missing.`);
    expect(result.stdout.match(/::error::/g) ?? []).toHaveLength(missing.length);
    expect(result.stdout + result.stderr).not.toContain('inert-');
  });
});

describe('release token and permission boundaries', () => {
  it('requests only the selected repository and two required write permissions', () => {
    expect(mint.uses).toBe('actions/create-github-app-token@v3');
    expect(mint.with).toEqual({
      'app-id': '${{ vars.RELEASE_APP_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: 'imajin-ai',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.release.permissions).toBeUndefined();
  });

  it('uses the App for both persisted push credentials and PR creation, never the default token', () => {
    expect(checkout.with.token).toBe(appToken);
    expect(checkout.with['persist-credentials']).not.toBe(false);
    expect(pr.env.GH_TOKEN).toBe(appToken);
    const push = steps.find((step) => step.name === 'Push the release branch');
    expect(push.run).toBe('git push origin "release/v$VERSION"');
    expect(push.env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(steps)).not.toMatch(/github\.token|secrets\.GITHUB_TOKEN|pull_request_target/);
    expect(steps.some((step) => /gh workflow run|workflow_dispatch/.test(step.run ?? ''))).toBe(false);
  });

  it('keeps main-only dispatch, bump input and Node-24 action majors', () => {
    expect(workflow.jobs.release.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.bump).toEqual({
      description: 'Version bump type', required: true, type: 'choice',
      options: ['patch', 'minor'], default: 'patch',
    });
    expect(checkout.uses).toBe('actions/checkout@v7');
    expect(checkout.with).toMatchObject({ ref: 'main', 'fetch-depth': 0, 'fetch-tags': true });
    expect(steps.find((step) => step.uses?.startsWith('actions/setup-node@'))).toMatchObject({
      uses: 'actions/setup-node@v7', with: { 'node-version': 22 },
    });
  });

  it('keeps required CI jobs on the native pull_request trigger', () => {
    const ci = YAML.parse(read('.github/workflows/ci.yml'));
    expect(ci.on.pull_request).toEqual({ branches: ['main'] });
    const names = new Set(Object.values(ci.jobs).map((job) => job.name));
    for (const name of ['Lint & Typecheck', 'Test', 'Build', 'Check Migrations', 'CI Guards', 'SonarCloud']) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('has no default-token PR-create step anywhere in the workflows', () => {
    for (const file of readdirSync(new URL('.github/workflows/', root))) {
      if (!/\.ya?ml$/.test(file)) continue;
      const candidate = YAML.parse(read(`.github/workflows/${file}`));
      for (const job of Object.values(candidate.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!/gh pr create|pulls\.create|createPullRequest/.test(step.run ?? '')) continue;
          expect(step.env?.GH_TOKEN, `${file}: ${step.name}`).toBe(appToken);
        }
      }
    }
  });
});

describe('release PR compatibility and operator documentation', () => {
  it('preserves the exact release body template and PR title/base/head', () => {
    const body = pr.run.split('cat > "$BODY_FILE" <<EOF\n')[1].split('\nEOF')[0];
    expect(body).toBe([
      'Lockstep version bump to \\`v$VERSION\\`, opened by the [Release workflow](../actions/workflows/release.yml).',
      '',
      "Merging this PR (keeping its \\`release: v$VERSION\\` commit message intact) is what cuts the release: [\\`tag-release.yml\\`](../actions/workflows/tag-release.yml) tags the resulting merge commit as \\`v$VERSION\\` and dispatches [\\`deploy-prod.yml\\`](../actions/workflows/deploy-prod.yml) against that tag, which is gated by the \\`production\\` GitHub Environment's required reviewer — no separate approval step exists here, it's the same gate every other prod deploy already goes through.",
      '',
      'See \\`docs/npm-publishing.md\\`\'s "Cutting a release" section for the full mechanism.',
    ].join('\n'));
    expect(pr.run).toContain('--title "release: v$VERSION"');
    expect(pr.run).toContain('--base main');
    expect(pr.run).toContain('--head "release/v$VERSION"');
    expect(pr.run).toContain('--body-file "$BODY_FILE"');
  });

  it.each([
    'AGENTS.md', 'README.md', 'docs/npm-publishing.md',
    'docs/ops/DEPLOY-POSTURE.md', 'deploy/README.md', 'docs/packages/PUBLISHING.md',
  ])('%s documents the App setup and automatic PR flow with the setting OFF', (path) => {
    const doc = read(path);
    expect(doc).toContain('RELEASE_APP_ID');
    expect(doc).toContain('RELEASE_APP_PRIVATE_KEY');
    expect(doc).toMatch(/App.*(token|installation)/s);
    expect(doc).toContain('pull_request');
    expect(doc).toMatch(/(setting|pull requests) OFF/);
    expect(doc).not.toContain('every workflow authenticates with the default');
    expect(doc).not.toContain('then explicitly dispatches `ci.yml`');
  });
});
