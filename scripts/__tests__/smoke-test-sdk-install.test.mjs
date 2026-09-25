// smoke-test-sdk-install.test.mjs — runs the bash self-test for #2380 as
// part of the normal `pnpm test` / CI suite.
//
// scripts/smoke-test-sdk-install.sh itself needs a real GITHUB_PACKAGES_TOKEN
// and network access to GitHub Packages, so it can't run as a unit test.
// Its network-free coverage instead lives in a standalone `.test.sh` file
// (same pattern as scripts/__tests__/deploy-shell-scripts.test.mjs) — this
// wrapper is what actually wires it into `pnpm test`/`pnpm test:coverage`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('smoke-test-sdk-install-no-prune.test.sh (#2380)', () => {
  it('passes', () => {
    const scriptPath = path.join(scriptsDir, 'smoke-test-sdk-install-no-prune.test.sh');
    try {
      execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      // Surface the script's own ✅/❌ output in the test failure instead of
      // just "exit code 1", so a CI failure is diagnosable from the log
      // alone.
      const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
      throw new Error(`smoke-test-sdk-install-no-prune.test.sh failed:\n${output}`);
    }
    expect(true).toBe(true);
  });
});
