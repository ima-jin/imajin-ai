/**
 * Tests for src/index.ts's CLI entrypoint.
 *
 * `runCli()` (in-process, below): the guard at the bottom of index.ts
 * (`if (import.meta.url === ...) { await runCli(); }`) only runs as an
 * import side effect when the file is invoked directly — a plain `import`
 * from a test never triggers it, and v8 coverage can't see across a spawned
 * subprocess either (see scripts/__tests__/prepare-npm-publish-units.test.mjs's
 * header for the same constraint). `runCli` is parameterized over the
 * function it runs specifically so its try/catch can be exercised directly,
 * in-process, without a real `main()` run.
 *
 * CLI end-to-end (subprocess, below): spawns the real script via the
 * package's own `tsx` to confirm the whole thing — env validation, the
 * no-new-rows path, and an actual thrown error reaching the guard — behaves
 * correctly together. Not instrumented for coverage; that's `runCli`'s job.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/index';

describe('runCli', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('runs the given function and leaves exitCode untouched on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);

    await runCli(fn);

    expect(fn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('logs a fatal error and sets exitCode=1 when the function throws, without rethrowing', async () => {
    const error = new Error('boom');
    const fn = vi.fn().mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(runCli(fn)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('usage-emitter-claude-code: fatal error', error);
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

const SCRIPT = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

function runCliProcess(env: Record<string, string | undefined>) {
  try {
    const stdout = execFileSync(TSX_BIN, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: 0, output: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: err.status ?? 1,
      output: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''),
    };
  }
}

describe('usage-emitter-claude-code CLI entrypoint (end-to-end)', () => {
  it('exits 1 with a clear message when KERNEL_URL/USAGE_EMIT_TOKEN are missing', () => {
    const { status, output } = runCliProcess({ KERNEL_URL: undefined, USAGE_EMIT_TOKEN: undefined });

    expect(status).toBe(1);
    expect(output).toContain('KERNEL_URL and USAGE_EMIT_TOKEN environment variables are required');
  });

  it('reports no new usage rows and exits 0 when there are no session files', () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'usage-emitter-projects-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'usage-emitter-state-'));
    try {
      const { status, output } = runCliProcess({
        KERNEL_URL: 'https://kernel.test',
        USAGE_EMIT_TOKEN: 'tok_123',
        CLAUDE_PROJECTS_DIR: projectsDir,
        USAGE_EMITTER_STATE_FILE: join(stateDir, 'state.json'),
      });

      expect(status).toBe(0);
      expect(output).toContain('no new usage rows to report');
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('logs a fatal error and exits 1 when main() throws', () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'usage-emitter-projects-'));
    try {
      const { status, output } = runCliProcess({
        KERNEL_URL: 'https://kernel.test',
        USAGE_EMIT_TOKEN: 'tok_123',
        CLAUDE_PROJECTS_DIR: projectsDir,
        // A state file whose parent directory doesn't exist makes
        // saveState()'s writeFileSync throw (ENOENT), which propagates out
        // of main() uncaught — exactly what runCli()'s catch is for.
        USAGE_EMITTER_STATE_FILE: '/this-dir-should-not-exist-2169/state.json',
      });

      expect(status).toBe(1);
      expect(output).toContain('usage-emitter-claude-code: fatal error');
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
