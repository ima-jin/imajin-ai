import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
const mocks = vi.hoisted(() => ({
  ingest: vi.fn(), Error: class extends Error { constructor(message: string, public status = 400) { super(message); } },
}));
vi.mock('@/src/lib/jin/session-command-intake', () => ({ ingestSessionCommandFrame: mocks.ingest }));
vi.mock('@/src/lib/jin/session-command-authority', () => ({ SessionCommandError: mocks.Error }));
import { POST } from '../route';
function request(body: unknown = { socketDid: 'did:imajin:agent', frame: { type: 'loop.approval.bound' } }, key = 'inert-fixture', literal = false) {
  return new NextRequest('http://localhost/jin/api/internal/session-events', {
    method: 'POST', headers: { 'x-internal-key': key }, body: literal ? String(body) : JSON.stringify(body),
  });
}
beforeEach(() => { vi.stubEnv('AUTH_INTERNAL_API_KEY', 'inert-fixture'); mocks.ingest.mockResolvedValue({ accepted: true, duplicate: false }); });
describe('internal authenticated session intake', () => {
  it('passes trusted socket DID independently from signed frame', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.ingest).toHaveBeenCalledWith('did:imajin:agent', { type: 'loop.approval.bound' });
  });
  it.each(['', 'wrong', 'same-length-x'])('denies missing/wrong internal key %s', async key => {
    expect((await POST(request(undefined, key))).status).toBe(401);
  });
  it('fails closed when key unconfigured and bounds raw frame', async () => {
    vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    expect((await POST(request())).status).toBe(401);
    vi.stubEnv('AUTH_INTERNAL_API_KEY', 'inert-fixture');
    expect((await POST(request('x'.repeat(26_000), 'inert-fixture', true))).status).toBe(413);
  });
  it.each(['{', '{}', JSON.stringify({ socketDid: 'agent', frame: {}, extra: true })])('rejects invalid body %s', async body => {
    expect((await POST(request(body, 'inert-fixture', true))).status).toBe(400);
  });
  it.each([
    [new mocks.Error('signature detail', 403), 403],
    [new ZodError([]), 400],
    [new Error('secret query parameters'), 503],
  ])('sanitizes validation and unexpected failures', async (error, status) => {
    mocks.ingest.mockRejectedValueOnce(error);
    const response = await POST(request());
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: 'Session event rejected' });
  });
});
