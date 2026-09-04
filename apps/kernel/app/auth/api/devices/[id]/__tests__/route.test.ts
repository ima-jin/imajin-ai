import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDeviceMutationMocks, makeReq, makeProps } from '../../__tests__/device-mutation-test-support';

// 401/404/403 auth+ownership behavior is covered once in
// src/lib/auth/__tests__/load-owned-device.test.ts — this route now just
// delegates to that helper, so it only needs to verify the error response
// passes through unchanged, plus its own success-path DB update.
let mocks: ReturnType<typeof setupDeviceMutationMocks>;
let DELETE: typeof import('../route').DELETE;

beforeEach(async () => {
  vi.resetModules();
  mocks = setupDeviceMutationMocks();
  ({ DELETE } = await import('../route'));
});

describe('DELETE /auth/api/devices/[id] (#306)', () => {
  it('returns the ownership-check error response unchanged', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'nope' }), { status: 403 });
    mocks.resolveOwnedDevice.mockResolvedValue({ errorResponse });

    const res = await DELETE(makeReq(), makeProps('dev_1'));

    expect(res).toBe(errorResponse);
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('revokes (soft-deletes) the device for its own DID and hides it from the list', async () => {
    mocks.resolveOwnedDevice.mockResolvedValue({ session: { sub: 'did:imajin:device-owner' }, device: { id: 'dev_1' } });
    mocks.updateReturningMock.mockReturnValue([{ id: 'dev_1', revoked: true }]);

    const res = await DELETE(makeReq(), makeProps('dev_1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.revoked).toBe(true);
    expect(body.device.revoked).toBe(true);
    expect(mocks.updateSetMock).toHaveBeenCalledWith({ revoked: true });
  });
});
