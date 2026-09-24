// deploy-shell-scripts.test.mjs — runs the bash self-tests for the deploy
// scripts touched by #2344 as part of the normal `pnpm test` / CI suite.
//
// scripts/lib/*.sh and scripts/reap-orphans.sh have no js runtime to unit
// test directly, so their coverage lives in standalone `.test.sh` files
// (PATH-shimmed fakes for `ps`/`pm2`/`ss`/`kill`, no bats dependency). This
// wrapper is what actually wires them into `pnpm test`/`pnpm test:coverage`
// so they run on every PR instead of only when someone remembers to run
// them by hand.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHELL_SELF_TESTS = [
  'lib/pm2-owned.test.sh',
  'lib/deploy-skip.test.sh',
  'reap-orphans.test.sh',
];

describe('deploy script self-tests (#2344)', () => {
  for (const relativePath of SHELL_SELF_TESTS) {
    it(`${relativePath} passes`, () => {
      const scriptPath = path.join(scriptsDir, relativePath);
      try {
        execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        // Surface the script's own ✅/❌ output in the test failure instead of
        // just "exit code 1", so a CI failure is diagnosable from the log
        // alone.
        const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
        throw new Error(`${relativePath} failed:\n${output}`);
      }
      expect(true).toBe(true);
    });
  }
});
