import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('gateway bootstrap contract (#3185)', () => {
  it('migrates and rolls back a fake host and rejects invalid authority/configuration', () => {
    expect(() => execFileSync('python3', [
      resolve(import.meta.dirname, 'infer-passthrough-bootstrap.test.py'),
    ], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  });

  it('uses one fixed privileged entry after the production gate, with no checkout or token in the job', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/infer-passthrough-bootstrap.yml'), 'utf8');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('sudo -n /usr/bin/systemctl start infer-passthrough-bootstrap.service');
    expect(workflow).not.toMatch(/actions\/checkout|secrets\.|GITHUB_TOKEN|GH_TOKEN/);
    const updaterUnit = readFileSync(resolve(root, 'deploy/infer-passthrough/infer-passthrough-update.service'), 'utf8');
    expect(updaterUnit).toContain('PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });
});
