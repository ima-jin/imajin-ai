/**
 * Shared test setup for the per-device mutation routes (#306):
 * `DELETE /api/devices/[id]` and `POST /api/devices/[id]/trust`. Both mock
 * the same three dependencies (logger, config, `resolveOwnedDevice`) and
 * the same `db.update(...)` chain, differing only in which field they set.
 *
 * `vi.mock()`/`vi.hoisted()` are hoisted above a test file's own imports,
 * so they cannot reference a shared factory imported from another module
 * (confirmed empirically: doing so throws "Cannot access '<import>' before
 * initialization"). `vi.doMock()` has no such restriction — it registers
 * lazily, in normal execution order — so callers must `vi.resetModules()`
 * and dynamically `import()` the route module fresh in each test after
 * calling this.
 */
import { vi } from 'vitest';
import type { NextRequest } from 'next/server';

export function setupDeviceMutationMocks() {
  const resolveOwnedDevice = vi.fn();

  const updateReturningMock = vi.fn();
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  vi.doMock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
  vi.doMock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
  vi.doMock('@/src/lib/auth/load-owned-device', () => ({
    resolveOwnedDevice,
    isOwnedDeviceError: (result: unknown) => !!result && typeof result === 'object' && 'errorResponse' in result,
  }));
  vi.doMock('@/src/db', () => ({ db: { update: updateMock }, devices: { id: 'id' } }));
  vi.doMock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

  return { resolveOwnedDevice, updateReturningMock, updateWhereMock, updateSetMock, updateMock };
}

export function makeReq(): NextRequest {
  return { headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

export function makeProps(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
