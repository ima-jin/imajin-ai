import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const action = parse(readFileSync('.github/actions/vault-ssh-deploy/action.yml', 'utf8'));

it('dry-runs the reusable action lifecycle with tmpfs fixtures and mocked transports', () => {
  const result = spawnSync('python3', ['scripts/__tests__/vault-ssh-deploy.test.py'], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: '/dev/shm' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('OK');
});

it('keeps one cross-repository action generic, input-injection safe and always cleans up', () => {
  expect(action.runs.using).toBe('composite');
  for (const name of ['host', 'principal', 'command', 'known-hosts', 'kernel-url', 'grant-id', 'ca-id', 'purpose']) {
    expect(action.inputs[name].required).toBe(true);
  }
  expect(action.inputs.ttl.default).toBe('600');
  expect(action.runs.steps).toHaveLength(3);
  expect(action.runs.steps[2].if).toBe('${{ always() }}');
  for (const step of action.runs.steps) {
    expect(step.run).not.toContain('${{');
    expect(step.run).toContain('$GITHUB_ACTION_PATH/../../../deploy/vault-ssh-deploy.py');
    expect(step.shell).toBe('bash');
    expect(step.env.TMPDIR).toBe('/dev/shm');
  }
  expect(action.runs.steps[1].env.VAULT_SSH_DIR).toBe('${{ steps.memory.outputs.directory }}');
  expect(action.runs.steps[2].env.VAULT_SSH_DIR).toBe('${{ steps.memory.outputs.directory }}');
  expect(JSON.stringify(action).toLowerCase()).not.toContain('postal');
});

it('documents a cross-repository caller and provides a credential-free CI dry-run', () => {
  const guide = readFileSync('docs/deploy/vault-ssh-deploy.md', 'utf8');
  const workflow = parse(readFileSync('.github/workflows/vault-ssh-dry-run.yml', 'utf8'));
  expect(guide).toContain('uses: ima-jin/imajin-ai/.github/actions/vault-ssh-deploy@REVIEWED_COMMIT_SHA');
  expect(guide).toContain('id-token: write');
  expect(guide).toContain('environment: production');
  expect(workflow.permissions).toEqual({ contents: 'read', packages: 'read' });
  expect(workflow.jobs['dry-run'].steps.at(-1).run).toBe('python3 scripts/__tests__/vault-ssh-deploy.test.py');
});
