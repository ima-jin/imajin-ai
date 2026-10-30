import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflowFile = resolve(root, '.github/workflows/infer-passthrough-bootstrap.yml');
const selectedWorkflow = 'ima-jin/imajin-ai/.github/workflows/infer-passthrough-bootstrap.yml@refs/heads/main';
const workflow = parse(readFileSync(workflowFile, 'utf8'));

describe('gateway bootstrap contract (#3185)', () => {
  it('migrates and rolls back a fake host and rejects invalid authority/configuration', () => {
    expect(() => execFileSync('python3', [
      resolve(import.meta.dirname, 'infer-passthrough-bootstrap.test.py'),
    ], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  });

  it('uses one fixed privileged entry after the production gate, with no checkout or token in the job', () => {
    const source = readFileSync(workflowFile, 'utf8');
    expect(source).toContain('environment: production');
    expect(source).toContain('sudo -n /usr/bin/systemctl start infer-passthrough-bootstrap.service');
    expect(source).not.toMatch(/actions\/checkout|secrets\.|GITHUB_TOKEN|GH_TOKEN/);
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const updaterUnit = readFileSync(resolve(root, 'deploy/infer-passthrough/infer-passthrough-update.service'), 'utf8');
    expect(updaterUnit).toContain('PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });

  it('passes context through env and guards before the privileged step without interpolating shell code', () => {
    const [guard, bootstrap] = workflow.jobs.bootstrap.steps;
    expect(guard.name).toBe('Verify selected main workflow');
    expect(guard.shell).toBe('bash');
    expect(guard.env).toEqual({
      BOOTSTRAP_REF: '${{ github.ref }}',
      BOOTSTRAP_WORKFLOW_REF: '${{ github.workflow_ref }}',
    });
    expect(guard.run).not.toContain('${{');
    expect(bootstrap.run).toBe('sudo -n /usr/bin/systemctl start infer-passthrough-bootstrap.service');
  });

  it.each([
    ['refs/heads/main', selectedWorkflow, 0],
    ['refs/heads/feature', selectedWorkflow, 1],
    ['refs/tags/v1.2.3', selectedWorkflow, 1],
    ['refs/pull/3188/merge', selectedWorkflow, 1],
    ['refs/heads/main', selectedWorkflow.replace('@refs/heads/main', '@refs/heads/feature'), 1],
    ['refs/heads/main', selectedWorkflow.replace('bootstrap.yml', 'other.yml'), 1],
    ['refs/heads/main', selectedWorkflow.replace('ima-jin/imajin-ai', 'other/repo'), 1],
    ['', selectedWorkflow, 1],
    ['refs/heads/main', '', 1],
    ['refs/heads/main; true', selectedWorkflow, 1],
  ])('runs the actual guard fail-closed for ref %s and workflow %s', (ref, workflowRef, status) => {
    const result = spawnSync('bash', ['-c', workflow.jobs.bootstrap.steps[0].run], {
      encoding: 'utf8',
      env: { ...process.env, BOOTSTRAP_REF: ref, BOOTSTRAP_WORKFLOW_REF: workflowRef },
    });
    expect(result.status).toBe(status);
    if (status) expect(result.stderr).toContain('Refusing bootstrap outside the selected main workflow');
  });

  it('documents the organization runner-group control and operator-only read checks', () => {
    const readme = readFileSync(resolve(root, 'deploy/infer-passthrough/README.md'), 'utf8');
    for (const text of [
      'Org settings → Actions → Runner groups', 'organization level',
      'visibility: selected', 'restricted_to_workflows: true',
      'allows_public_repositories: false', selectedWorkflow,
      'gh api orgs/ima-jin/actions/runner-groups',
      'orgs/ima-jin/actions/runner-groups/<id>/repositories',
      'orgs/ima-jin/actions/runner-groups/<id>/runners',
      'gateway runner ID appears in none of them', 'second layer only',
      'Neither that group nor a bootstrapped host is claimed here',
    ]) expect(readme).toContain(text);
    expect(readme).not.toContain('Configure\nthat runner to accept only protected production workflows');
  });
});
