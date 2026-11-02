import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { parseLivenessEvent } from '@/src/lib/jin/ops-liveness-contract';
const record = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/jin/ops-liveness', () => ({ recordLivenessEvent: record }));
import { POST } from '../route';

const event = {
  id: 'a25ce4aa-fcff-44a3-a3bb-d25e16e95034', app: 'prod-jin', port: 7000,
  outcome: 'restarted', failures: 3, at: '2026-11-02T13:00:00.000Z',
};
function request(body: string, key?: string) {
  return new NextRequest('http://localhost/jin/api/internal/ops-events', {
    method: 'POST', body,
    headers: key === undefined ? {} : { 'x-internal-key': key },
  });
}
beforeEach(() => {
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'test-only-key');
  record.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('internal ops event ingestion', () => {
  it.each([undefined, 'wrong', 'same-size-bad'])('rejects absent or incorrect authority: %s', async key => {
    expect((await POST(request(JSON.stringify(event), key))).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });
  it('fails closed when server authority is unset', async () => {
    vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    expect((await POST(request(JSON.stringify(event), 'test-only-key'))).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });
  it('acknowledges only after durable persistence and drops caller identity/secret fields', async () => {
    const response = await POST(request(JSON.stringify({
      ...event, operatorDid: 'did:imajin:attacker', headers: { cookie: 'not-persisted' },
    }), 'test-only-key'));
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(event);
  });
  it('returns 503 on persistence failure so the probe retries its outbox', async () => {
    record.mockRejectedValue(new Error('private database details'));
    const response = await POST(request(JSON.stringify(event), 'test-only-key'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private database details');
  });
  it.each([
    ['not-json', 400], [JSON.stringify({}), 400], [' '.repeat(4097), 413],
  ])('rejects malformed or oversized bodies', async (body, status) => {
    expect((await POST(request(body as string, 'test-only-key'))).status).toBe(status);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('liveness event validation', () => {
  it.each([
    null, [], 'text', {}, { ...event, id: 'invalid' }, { ...event, id: '-'.repeat(36) },
    { ...event, app: 'prod-jin;restart all' },
    { ...event, port: 0 }, { ...event, port: 65536 }, { ...event, port: 1.5 },
    { ...event, failures: 0 }, { ...event, failures: 101 }, { ...event, failures: 1.5 },
    { ...event, outcome: 'unknown' }, { ...event, at: 'invalid' },
    { ...event, at: '2026-11-02' }, { ...event, at: null },
  ])('rejects invalid event %j', value => {
    expect(parseLivenessEvent(value)).toBeNull();
  });
});
