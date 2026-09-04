import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDeviceMutationMocks, makeReq, makeProps } from '../../../__tests__/device-mutation-test-support';

// 401/404/403 auth+ownership behavior is covered once in
// src/lib/auth/__tests__/load-owned-device.test.ts — this route now just
// delegates to that helper, so it only needs to verify the error response
// passes through unchanged, plus its own success-path DB update.
let mocks: ReturnType<typeof setupDeviceMutationMocks>;
let POST: typeof import('../route').POST;

beforeEach(async () => {
  vi.resetModules();
  mocks = setupDeviceMutationMocks();
  ({ POST } = await import('../route'));
});

describe('POST /auth/api/devices/[id]/trust (#306)', () => {
  it('returns the ownership-check error response unchanged', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'nope' }), { status: 403 });
    mocks.resolveOwnedDevice.mockResolvedValue({ errorResponse });

    const res = await POST(makeReq(), makeProps('dev_1'));

    expect(res).toBe(errorResponse);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('marks the device trusted for its own DID', async () => {
    mocks.resolveOwnedDevice.mockResolvedValue({ session: { sub: 'did:imajin:device-owner' }, device: { id: 'dev_1' } });
    mocks.updateReturningMock.mockReturnValue([{ id: 'dev_1', trusted: true }]);

    const res = await POST(makeReq(), makeProps('dev_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.device.trusted).toBe(true);
    expect(mocks.updateSetMock).toHaveBeenCalledWith({ trusted: true });
  });
});
