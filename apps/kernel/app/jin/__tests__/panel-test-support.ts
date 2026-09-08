import { vi } from 'vitest';

/**
 * Stub `setInterval`/`clearInterval` so a panel's poll tick can be driven
 * deterministically (invoking the captured callback directly) instead of
 * depending on fake-timer/real-timer interplay with async fetch + React
 * effects, which is flaky in combination with `@testing-library/react`.
 * Shared by every /jin panel test suite (usage-feed-panel, operator-
 * approvals-panel) since each one polls on the same `setInterval` shape.
 */
export function installIntervalSpy(): Array<() => void> {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal('setInterval', vi.fn((cb: () => void) => {
    callbacks.push(cb);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }));
  vi.stubGlobal('clearInterval', vi.fn());
  return callbacks;
}
