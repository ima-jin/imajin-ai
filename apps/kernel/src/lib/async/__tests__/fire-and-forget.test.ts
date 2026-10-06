import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireAndForget } from '../fire-and-forget';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fireAndForget', () => {
  it('returns synchronously without awaiting the task', () => {
    const result = fireAndForget(new Promise(() => {}), 'test:pending');
    expect(result).toBeUndefined();
  });

  it('does not log when the task resolves', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireAndForget(Promise.resolve('ok'), 'test:ok');
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs with context and does not reject when the task rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => fireAndForget(Promise.reject(boom), 'test:fail')).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(spy).toHaveBeenCalledWith('[test:fail] unhandled async error', boom);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
