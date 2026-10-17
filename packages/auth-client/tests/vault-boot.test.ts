import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultBoot } from '../src/vault-boot';

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('../src/load-from-vault', () => ({ loadFromVault: loadMock }));

const credentials = { values: { DATABASE_URL: 'FAKE_TEST_DATABASE_URL_NOT_A_CONNECTION_STRING' }, degraded: ['WEBHOOK_SECRET'] };
const options = {
  vault: { keys: [{ key: 'DATABASE_URL', onMissing: 'fail' as const }] },
  configure: ({ values }: typeof credentials) => ({ DATABASE_URL: values.DATABASE_URL }),
};

beforeEach(() => {
  vi.resetModules();
  loadMock.mockReset().mockResolvedValue(credentials);
});
afterEach(() => vi.unstubAllEnvs());

describe('typed in-memory vault boot', () => {
  it('loads DATABASE_URL before a delayed DB module initializes without populating process.env', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    let resolveLoad!: (value: typeof credentials) => void;
    loadMock.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve; }));
    const { boot } = await import('./fixtures/vault-boot-config');
    const start = vi.fn(async (config) => {
      const db = await import('./fixtures/vault-boot-db');
      expect(db.databaseUrlAtModuleInitialization).toBe(config.DATABASE_URL);
      expect(config.optionalWebhook).toBeUndefined();
      return 'FAKE_STARTED';
    });
    expect(() => boot.getConfig()).toThrow('configuration unavailable');
    const result = boot.start(start);
    expect(start).not.toHaveBeenCalled();
    expect(() => boot.getConfig()).toThrow('configuration unavailable');
    resolveLoad(credentials);
    await expect(result).resolves.toBe('FAKE_STARTED');
    expect(start).toHaveBeenCalledOnce();
    expect(Object.isFrozen(boot.getConfig())).toBe(true);
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(loadMock).toHaveBeenCalledWith(expect.objectContaining({
      keys: [
        { key: 'DATABASE_URL', onMissing: 'fail' },
        { key: 'WEBHOOK_SECRET', onMissing: 'degrade' },
      ],
    }));
  });

  it('supports asynchronous configuration before invoking start', async () => {
    const configure = vi.fn(async () => ({ DATABASE_URL: credentials.values.DATABASE_URL }));
    const boot = createVaultBoot({ ...options, configure });
    await boot.start((config) => expect(boot.getConfig()).toBe(config));
    expect(configure).toHaveBeenCalledWith(credentials);
  });

  it('rejects repeated and concurrent startup without reloading credentials', async () => {
    const boot = createVaultBoot(options);
    const first = boot.start(() => 'FAKE_STARTED');
    await expect(boot.start(vi.fn())).rejects.toThrow(/^vault boot: already started$/);
    await first;
    await expect(boot.start(vi.fn())).rejects.toThrow(/^vault boot: already started$/);
    expect(loadMock).toHaveBeenCalledOnce();
  });

  it.each(['load', 'configure', 'start'])('redacts %s errors, withholds configuration and never retries', async (stage) => {
    const secretError = new Error('FAKE_TEST_SECRET_DO_NOT_ECHO');
    const configure = vi.fn(() => {
      if (stage === 'configure') throw secretError;
      return { DATABASE_URL: credentials.values.DATABASE_URL };
    });
    const start = vi.fn(() => {
      if (stage === 'start') throw secretError;
    });
    if (stage === 'load') loadMock.mockRejectedValue(secretError);
    const boot = createVaultBoot({ ...options, configure });
    const error = await boot.start(start).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('vault boot: startup failed');
    expect((error as Error).cause).toBeUndefined();
    expect(() => boot.getConfig()).toThrow(/^vault boot: configuration unavailable$/);
    if (stage !== 'start') expect(start).not.toHaveBeenCalled();
    if (stage === 'load') expect(configure).not.toHaveBeenCalled();
    await expect(boot.start(start)).rejects.toThrow(/^vault boot: already started$/);
  });
});
