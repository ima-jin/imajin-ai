import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { runProvisionMock } = vi.hoisted(() => ({ runProvisionMock: vi.fn() }));

vi.mock('../src/runner', () => ({ runProvision: (...args: unknown[]) => runProvisionMock(...args) }));

import { parseArgs, main } from '../src/cli';

const ORIGINAL_ARGV = process.argv;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  process.env = { ...ORIGINAL_ENV };
});

describe('parseArgs', () => {
  it('requires provision-id, kernel-url, and operator-token', () => {
    delete process.env.KERNEL_BASE_URL;
    delete process.env.OPERATOR_TOKEN;

    expect(() => parseArgs([])).toThrow(/--provision-id/);
    expect(() => parseArgs(['--provision-id', 'prov_1'])).toThrow(/--kernel-url/);
    expect(() => parseArgs(['--provision-id', 'prov_1', '--kernel-url', 'https://kernel.test'])).toThrow(/--operator-token/);
  });

  it('falls back to environment variables when flags are omitted', () => {
    process.env.KERNEL_BASE_URL = 'https://kernel.test';
    process.env.OPERATOR_TOKEN = 'env-owner-token';
    process.env.PROVISIONER_RUNNER_TOKEN = 'env-runner-token';

    const args = parseArgs(['--provision-id', 'prov_1']);

    expect(args).toMatchObject({
      provisionId: 'prov_1',
      kernelBaseUrl: 'https://kernel.test',
      operatorToken: 'env-owner-token',
      runnerToken: 'env-runner-token',
      dryRun: false,
    });
  });

  it('parses explicit flags, including --dry-run and optional out/compose dirs', () => {
    const args = parseArgs([
      '--provision-id', 'prov_1',
      '--kernel-url', 'https://kernel.test',
      '--operator-token', 'owner-token',
      '--runner-token', 'runner-token',
      '--out-dir', '/tmp/out',
      '--compose-dir', '/tmp/compose',
      '--dry-run',
    ]);

    expect(args).toEqual({
      provisionId: 'prov_1',
      kernelBaseUrl: 'https://kernel.test',
      operatorToken: 'owner-token',
      runnerToken: 'runner-token',
      outDir: '/tmp/out',
      composeDir: '/tmp/compose',
      dryRun: true,
    });
  });
});

describe('main', () => {
  it('parses argv, calls runProvision, and reports the dry-run plan', async () => {
    process.argv = [
      'node', 'cli.js',
      '--provision-id', 'prov_1',
      '--kernel-url', 'https://kernel.test',
      '--operator-token', 'owner-token',
      '--dry-run',
    ];
    runProvisionMock.mockResolvedValue({
      provision: { id: 'prov_1', placement: 'local' },
      outDir: '/tmp/out',
      filesWritten: ['/tmp/out/envelope/SOUL.md'],
      composeRan: false,
      callbackSent: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(runProvisionMock).toHaveBeenCalledWith(expect.objectContaining({
      provisionId: 'prov_1',
      kernelBaseUrl: 'https://kernel.test',
      operatorToken: 'owner-token',
      dryRun: true,
    }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
  });

  it('reports compose/callback status for a non-dry-run hosted run', async () => {
    process.argv = [
      'node', 'cli.js',
      '--provision-id', 'prov_1',
      '--kernel-url', 'https://kernel.test',
      '--operator-token', 'owner-token',
    ];
    runProvisionMock.mockResolvedValue({
      provision: { id: 'prov_1', placement: 'hosted' },
      outDir: '/tmp/out',
      filesWritten: ['/tmp/out/envelope/SOUL.md'],
      composeRan: true,
      callbackSent: true,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('compose ran: true, callback sent: true'));
  });
});
