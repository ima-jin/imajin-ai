import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import AgentReporter from '../agent-reporter.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = join(root, 'scripts/test-agent.mjs');
const vitest = fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url));
const summary = /^\d+ passed · \d+ skipped · \d+ files · \d+\.\d{2}s duration\n$/;

function reporter() {
  const log = vi.fn();
  const instance = new AgentReporter();
  instance.onInit({ logger: { log } });
  return { instance, log, output: () => log.mock.calls.map(([line]) => line).join('\n') + '\n' };
}

function task(id, state, extra = {}) {
  return { id, name: id, type: 'test', result: { state }, ...extra };
}

function fixture(source, config = {}) {
  const dir = mkdtempSync(join(root, 'node_modules/.agent-reporter-'));
  writeFileSync(join(dir, 'sample.test.mjs'),
    `import { test, expect, beforeAll } from ${JSON.stringify(vitest)};\n${source}\n`);
  writeFileSync(join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify({
    test: { include: ['*.test.mjs'], maxWorkers: 1, minWorkers: 1, ...config },
  })};\n`);
  return dir;
}

function run(dir, args = ['--agent'], env = {}) {
  const childEnv = { ...process.env, CI: '', WARP_AGENT: '', NO_COLOR: '1', ...env };
  delete childEnv.FORCE_COLOR;
  const result = spawnSync(process.execPath, [runner, ...args, '--root', dir,
    '--config', join(dir, 'vitest.config.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: childEnv,
  });
  expect(result.error).toBeUndefined();
  return { ...result, output: result.stdout + result.stderr };
}

describe('AgentReporter', () => {
  it('prints exactly one summary and drops passing console output', () => {
    const { instance, output } = reporter();
    instance.onUserConsoleLog({ taskId: 'pass', content: 'PRIVATE PASSING LOG\n' });
    instance.onFinished([{ name: 'file', tasks: [task('pass', 'pass'), task('skip', 'skip'),
      task('todo', undefined, { mode: 'todo' })] }]);
    expect(output()).toMatch(/^1 passed · 2 skipped · 1 files · \d+\.\d{2}s duration\n$/);
    expect(instance.logs.size).toBe(0);
  });

  it('prints only a failing task, its diff, trimmed stack and own console', () => {
    const { instance, output } = reporter();
    instance.onUserConsoleLog({ taskId: 'pass', content: 'PASS LOG' });
    instance.onUserConsoleLog({ taskId: 'fail', content: 'FAIL LOG\n' });
    const stack = ['Error', ' at node_modules/internal.js:1',
      ...Array.from({ length: 8 }, (_, n) => ` at test.mjs:${n}`)].join('\n');
    instance.onFinished([{ name: 'file', tasks: [task('pass', 'pass'),
      task('fail', 'fail', { result: { state: 'fail', errors: [
        { name: 'AssertionError', message: 'mismatch', diff: '- expected\n+ actual', stack },
      ] } })] }]);
    expect(output()).toContain('FAIL file > fail\nAssertionError: mismatch\n- expected\n+ actual');
    expect(output()).toContain('FAIL LOG');
    expect(output()).not.toMatch(/PASS LOG|node_modules|test.mjs:5|passed/);
    expect(output().match(/ at test/g)).toHaveLength(5);
  });

  it('reports collection/hook failures and unhandled errors without a success summary', () => {
    const { instance, output } = reporter();
    instance.onFinished([{ name: 'broken suite', result: { state: 'fail', errors: [
      { message: 'hook failed' },
    ] } }], [{ message: 'unhandled rejection' }]);
    expect(output()).toContain('FAIL broken suite\nError: hook failed');
    expect(output()).toContain('Error: unhandled rejection');
    expect(output()).not.toContain('passed');
  });

  it('does not claim success when a failed test has no serialized errors', () => {
    const { instance, output } = reporter();
    instance.onFinished([task('empty failure', 'fail')]);
    expect(output()).toBe('FAIL empty failure\n');
  });

  it('drops logs from a successful retry and resets across runs', () => {
    const { instance, log, output } = reporter();
    instance.onUserConsoleLog({ taskId: 'retry', content: 'retry noise' });
    instance.onFinished([task('retry', 'pass')]);
    expect(output()).not.toContain('retry noise');
    instance.onInit({ logger: { log } });
    expect(instance.logs.size).toBe(0);
  });
});

describe('real Vitest 2.1.9 invocation', () => {
  const passSource = `import { spawnSync } from 'node:child_process';
test('passing test', () => {
  console.log('PASS CONSOLE');
  process.stdout.write('RAW PASS STDOUT\\n');
  process.stderr.write('RAW PASS STDERR\\n');
  spawnSync(process.execPath, ['-e', 'console.log("SUBPROCESS PASS")'], { stdio: 'inherit' });
  expect(1).toBe(1);
});
test.skip('skipped test', () => {});`;

  it.each([
    ['explicit', ['--agent'], {}],
    ['Warp', [], { WARP_AGENT: '1' }],
    ['CI', [], { CI: 'true' }],
  ])('prints one line in %s mode', (_name, args, env) => {
    const result = run(fixture(passSource), args, env);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(summary);
    expect(result.output).toContain('1 passed · 1 skipped · 1 files');
  }, 30000);

  it('leaves the default human reporter available outside Warp/CI', () => {
    const result = run(fixture(passSource), []);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS CONSOLE');
    expect(result.output).toContain('Test Files');
  }, 30000);

  it('preserves non-zero exit, assertion diff, stack and failing console only', () => {
    const result = run(fixture(`${passSource}
test('failing test', () => { console.error('FAIL CONSOLE'); expect({ value: 1 }).toEqual({ value: 2 }); });`));
    expect(result.status).toBe(1);
    expect(result.output).toContain('failing test');
    expect(result.output).toContain('FAIL CONSOLE');
    expect(result.output).toContain('AssertionError');
    expect(result.output).toMatch(/-\s+"value": 2/);
    expect(result.output).toMatch(/\+\s+"value": 1/);
    expect(result.output).toContain('sample.test.mjs:');
    expect(result.output).not.toMatch(/passing test|skipped test|PASS CONSOLE|RAW PASS|SUBPROCESS PASS|Test Files|passed/);
  }, 30000);

  it('does not swallow suite setup failures', () => {
    const result = run(fixture(`beforeAll(() => { throw new Error('SETUP FAILURE'); });
test('blocked test', () => {});`));
    expect(result.status).toBe(1);
    expect(result.output).toContain('SETUP FAILURE');
    expect(result.output).not.toContain('passed');
  }, 30000);

  it('preserves a collection failure and its non-zero exit', () => {
    const result = run(fixture(`throw new Error('COLLECTION FAILURE');`));
    expect(result.status).toBe(1);
    expect(result.output).toContain('COLLECTION FAILURE');
    expect(result.output).not.toContain('passed');
  }, 30000);

  it('preserves no-test exit codes and supports explicit passWithNoTests', () => {
    const dir = fixture(passSource);
    expect(run(dir, ['--agent', 'not-a-matching-file']).status).toBe(1);
    const allowed = run(dir, ['--agent', 'not-a-matching-file', '--passWithNoTests']);
    expect(allowed.status).toBe(0);
    expect(allowed.output).toContain('No test files found, exiting with code 0');
  }, 30000);

  it('preserves startup diagnostics when there is no failing test to report', () => {
    const dir = fixture(passSource);
    writeFileSync(join(dir, 'vitest.config.mjs'), 'throw new Error("INVALID CONFIG");\n');
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('INVALID CONFIG');
    expect(result.output).not.toMatch(summary);
  }, 30000);

  it('emits lcov without a coverage table or extra passing lines', () => {
    const dir = fixture(`import { value } from './value.mjs';
test('coverage', () => { expect(value()).toBe(42); });`, {
      coverage: { include: ['value.mjs'], reporter: ['text-summary', 'lcov'] },
    });
    writeFileSync(join(dir, 'value.mjs'), 'export const value = () => 42;\n');
    const result = run(dir, ['--agent', '--coverage']);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(summary);
    const lcov = join(dir, 'coverage/lcov.info');
    expect(existsSync(lcov)).toBe(true);
    expect(readFileSync(lcov, 'utf8')).toContain('SF:value.mjs');
  }, 30000);
});

describe('agent script and workflow contracts', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ci = YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));

  it('keeps human scripts and Vitest major unchanged', () => {
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
    expect(pkg.devDependencies.vitest).toBe('2.1.9');
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe('2.1.9');
    expect(pkg.scripts['test:agent']).toBe('node scripts/test-agent.mjs --agent');
    expect(pkg.scripts['test:run']).toBe('node scripts/test-agent.mjs');
  });

  it.each(['build', 'lint', 'typecheck'])('%s agents use errors-only Turbo logs in both CI paths', (name) => {
    expect(pkg.scripts[`${name}:agent`]).toBe(`turbo run ${name} --concurrency=4 --output-logs=errors-only`);
    const job = ci.jobs[name === 'build' ? 'build' : 'lint-and-typecheck'];
    const commands = job.steps.map((step) => step.run ?? '');
    expect(commands).toContain(`pnpm --silent ${name}:agent`);
    expect(commands.some((cmd) => cmd.startsWith(`pnpm --silent ${name}:agent --filter=`))).toBe(true);
  });

  it('keeps coverage and merge-group tests quiet without changing triggers', () => {
    expect(ci.on).toHaveProperty('merge_group');
    expect(ci.jobs.test.steps.some((step) => step.run === 'pnpm --silent test:agent --coverage')).toBe(true);
    expect(readFileSync(join(root, 'scripts/ci/merge-group-tests.sh'), 'utf8'))
      .toContain('pnpm --silent test:agent "${FILTERS[@]}"');
    expect(ci.jobs.test.steps.some((step) => step.with?.path === 'coverage/lcov.info')).toBe(true);
  });

  it('uses quiet installs in CI and documents Warp setup plus output discipline', () => {
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps) {
        if (step.run?.startsWith('pnpm install ')) expect(step.run).toContain('--reporter=silent');
      }
    }
    const guidance = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    for (const text of ['only affected test files', 'full suite once via `pnpm test:agent`',
      '--reporter=silent', 'Redirect long output to a file and grep']) {
      expect(guidance).toContain(text);
    }
  });
});
