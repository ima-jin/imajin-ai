import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), reaper: vi.fn(), stop: vi.fn(), stopReaper: vi.fn(), log: vi.fn(),
}));
vi.mock('../runner', () => ({ startScheduler: mocks.start, jsonLineLog: mocks.log }));
vi.mock('../db-reaper', () => ({ startDatabaseReaper: mocks.reaper }));
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

it('starts the direct reaper in the existing scheduler and stops both on shutdown', async () => {
  mocks.start.mockResolvedValue({ stop: mocks.stop });
  mocks.reaper.mockReturnValue({ stop: mocks.stopReaper });
  const on = vi.spyOn(process, 'on').mockReturnValue(process);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../scheduler');
  expect(mocks.reaper).toHaveBeenCalledWith(process.env, mocks.log);
  const shutdown = on.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1] as () => void;
  expect(shutdown).toBeTypeOf('function');
  shutdown();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.stopReaper).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(0);
});

it('fails visibly when the scheduler cannot start', async () => {
  mocks.start.mockRejectedValue(new Error('fixture configuration failure'));
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('../scheduler');
  await Promise.resolve();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('cron.scheduler-failed-to-start'));
  expect(exit).toHaveBeenCalledWith(1);
});
