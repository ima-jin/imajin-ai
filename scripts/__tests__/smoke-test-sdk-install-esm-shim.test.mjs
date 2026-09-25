// smoke-test-sdk-install-esm-shim.test.mjs — runs the bash self-test for
// #2383 as part of the normal `pnpm test` / CI suite.
//
// scripts/smoke-test-sdk-install.sh itself needs a real GITHUB_PACKAGES_TOKEN
// and network access to GitHub Packages, so it can't run as a unit test. Its
// network-free coverage for the #2383 `next/server` ESM resolution fix
// instead lives in a standalone `.test.sh` file (same pattern as
// scripts/smoke-test-sdk-install-no-prune.test.sh for #2380) — this wrapper
// is what actually wires it into `pnpm test`/`pnpm test:coverage`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('smoke-test-sdk-install-esm-shim.test.sh (#2383)', () => {
  it('passes', () => {
    const scriptPath = path.join(scriptsDir, 'smoke-test-sdk-install-esm-shim.test.sh');
    let output;
    try {
      output = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      // Surface the script's own ✅/❌ output in the test failure instead of
      // just "exit code 1", so a CI failure is diagnosable from the log
      // alone.
      const failureOutput = [err.stdout, err.stderr].filter(Boolean).join('\n');
      throw new Error(`smoke-test-sdk-install-esm-shim.test.sh failed:\n${failureOutput}`);
    }
    // A zero exit code alone doesn't prove the script's own assertions ran —
    // assert on its explicit success line too, so a silently-skipped/short-
    // circuited script body would still fail this test (#2383).
    expect(output).toContain('All smoke-test-sdk-install ESM-shim assertions passed.');
  });
});
