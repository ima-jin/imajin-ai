import { afterEach, expect, it, vi } from 'vitest';
const { create } = vi.hoisted(() => ({ create: vi.fn(() => Object.assign(() => undefined, { options: {} })) }));
vi.mock('postgres', () => ({ default: create }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); create.mockClear(); });
it('configures conservative server startup timeouts without changing max 10', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/runtime_test');
  const { getClient } = await import('../src/client');
  expect(getClient()).toBe(getClient());
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    max: 10, idle_timeout: 20, connect_timeout: 10,
    connection: { statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 },
  }));
});
it('uses explicit server timeout overrides including zero for dedicated jobs', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/runtime_test');
  vi.stubEnv('DB_STATEMENT_TIMEOUT_MS', '0');
  vi.stubEnv('DB_IDLE_TRANSACTION_TIMEOUT_MS', '120000');
  const { getClient } = await import('../src/client');
  getClient();
  expect(create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    connection: { statement_timeout: 0, idle_in_transaction_session_timeout: 120000 },
  }));
});
it('rejects missing connection configuration', async () => {
  vi.stubEnv('DATABASE_URL', '');
  const { getClient } = await import('../src/client');
  expect(() => getClient()).toThrow('DATABASE_URL');
  expect(create).not.toHaveBeenCalled();
});
