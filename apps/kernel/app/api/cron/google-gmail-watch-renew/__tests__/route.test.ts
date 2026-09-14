import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockListActiveGrantOwners, mockListWatchExpirations, mockWatch } = vi.hoisted(() => ({
  mockListActiveGrantOwners: vi.fn(),
  mockListWatchExpirations: vi.fn(),
  mockWatch: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/google/connector', () => ({ listActiveGrantOwners: mockListActiveGrantOwners }));
vi.mock('@/src/lib/google/gmail', () => ({ listWatchExpirations: mockListWatchExpirations, watch: mockWatch }));

import { GET } from '../route.js';

const JIN = 'did:imajin:jin';
const OTHER = 'did:imajin:other';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/google-gmail-watch-renew', { headers });
}

describe('GET /api/cron/google-gmail-watch-renew (#2144)', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListWatchExpirations.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockListActiveGrantOwners.mockResolvedValue([]);
    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockListActiveGrantOwners.mockResolvedValue([]);
    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('renews every owner with no prior watch row', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([JIN, OTHER]);
    mockListWatchExpirations.mockResolvedValue([]);
    mockWatch.mockResolvedValue({ historyId: '1', expiration: Date.now() + 7 * 24 * 60 * 60 * 1000, emailAddress: 'x@y.com' });

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { ok: boolean; owners: number; renewed: number };

    expect(response.status).toBe(200);
    expect(mockListActiveGrantOwners).toHaveBeenCalledWith('google:gmail:read');
    expect(mockWatch).toHaveBeenCalledWith(JIN);
    expect(mockWatch).toHaveBeenCalledWith(OTHER);
    expect(body.owners).toBe(2);
    expect(body.renewed).toBe(2);
  });

  it('skips an owner whose watch is not near expiry', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([JIN]);
    mockListWatchExpirations.mockResolvedValue([{ ownerDid: JIN, expiration: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000) }]);

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { renewed: number };

    expect(response.status).toBe(200);
    expect(mockWatch).not.toHaveBeenCalled();
    expect(body.renewed).toBe(0);
  });

  it('renews an owner whose watch expires within the renewal window', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([JIN]);
    mockListWatchExpirations.mockResolvedValue([{ ownerDid: JIN, expiration: new Date(Date.now() + 1000) }]);
    mockWatch.mockResolvedValue({ historyId: '1', expiration: Date.now(), emailAddress: 'x@y.com' });

    const response = await GET(makeRequest() as never);
    expect(mockWatch).toHaveBeenCalledWith(JIN);
    expect(response.status).toBe(200);
  });

  it('collects a per-owner failure without aborting the rest of the sweep', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockResolvedValue([JIN, OTHER]);
    mockListWatchExpirations.mockResolvedValue([]);
    mockWatch
      .mockRejectedValueOnce(new Error('google_no_credential'))
      .mockResolvedValueOnce({ historyId: '1', expiration: Date.now(), emailAddress: 'x@y.com' });

    const response = await GET(makeRequest() as never);
    const body = await response.json() as { renewed: number; failures: Array<{ ownerDid: string }> };

    expect(response.status).toBe(200);
    expect(body.renewed).toBe(1);
    expect(body.failures).toEqual([{ ownerDid: JIN, error: 'Error: google_no_credential' }]);
  });

  it('returns 500 when enumerating owners throws', async () => {
    delete process.env.CRON_SECRET;
    mockListActiveGrantOwners.mockRejectedValue(new Error('DB connection lost'));
    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
  });
});
