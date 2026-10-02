// @vitest-environment jsdom
/**
 * `useCancellableTimeout` (#2492): a timer scheduled through the hook must
 * never fire after unmount, and a newer schedule replaces a pending one.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useCancellableTimeout } from '../use-cancellable-timeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCancellableTimeout', () => {
  it('runs the callback after the delay', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCancellableTimeout());

    result.current(fn, 1000);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('replaces a still-pending timer when scheduled again', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useCancellableTimeout());

    result.current(first, 1000);
    result.current(second, 1000);
    vi.advanceTimersByTime(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never fires the callback after unmount', () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useCancellableTimeout());

    result.current(fn, 1000);
    unmount();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns a stable function across renders', () => {
    const { result, rerender } = renderHook(() => useCancellableTimeout());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
