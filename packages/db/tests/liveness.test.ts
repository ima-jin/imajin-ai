import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { unsafe } = vi.hoisted(() => ({ unsafe: vi.fn() }));
vi.mock('../src/client', () => ({ getClient: () => ({ unsafe }) }));
import { checkDatabaseLiveness } from '../src/liveness';
beforeEach(() => { vi.useFakeTimers(); unsafe.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
it('checks SELECT 1 through the shared client', async () => {
  unsafe.mockResolvedValue([{ value: 1 }]);
  expect(await checkDatabaseLiveness()).toBe(true);
  expect(unsafe).toHaveBeenCalledWith('SELECT 1');
  expect(vi.getTimerCount()).toBe(0);
});
it('returns unhealthy and cancels a wedged pool checkout at 1500ms', async () => {
  const cancel = vi.fn();
  unsafe.mockReturnValue(Object.assign(new Promise(() => undefined), { cancel }));
  const pending = checkDatabaseLiveness();
  await vi.advanceTimersByTimeAsync(1501);
  expect(await pending).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('fails closed without exposing database failures', async () => {
  unsafe.mockRejectedValue(new Error('private transport details'));
  expect(await checkDatabaseLiveness()).toBe(false);
  unsafe.mockImplementation(() => { throw new Error('not configured'); });
  expect(await checkDatabaseLiveness()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
