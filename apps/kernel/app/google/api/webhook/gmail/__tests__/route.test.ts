import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockResolveOwner, mockReadStoredHistoryId, mockAdvanceHistoryId, mockProcessHistorySince } = vi.hoisted(() => ({
  mockResolveOwner: vi.fn(),
  mockReadStoredHistoryId: vi.fn(),
  mockAdvanceHistoryId: vi.fn(),
  mockProcessHistorySince: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/google/gmail', () => ({
  resolveOwnerByGmailAddress: mockResolveOwner,
  readStoredHistoryId: mockReadStoredHistoryId,
  advanceHistoryId: mockAdvanceHistoryId,
  processHistorySince: mockProcessHistorySince,
}));

import { POST } from '../route.js';

const OWNER = 'did:imajin:jin';

function pushRequest(payload: unknown, opts: { token?: string } = {}): Request {
  const url = new URL('http://localhost/google/api/webhook/gmail');
  if (opts.token !== undefined) url.searchParams.set('token', opts.token);
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function pubsubEnvelope(notification: Record<string, unknown>) {
  return { message: { data: Buffer.from(JSON.stringify(notification)).toString('base64'), messageId: 'm1' } };
}

describe('POST /google/api/webhook/gmail (#2144)', () => {
  const originalPushToken = process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadStoredHistoryId.mockResolvedValue('100');
    mockProcessHistorySince.mockResolvedValue('101');
    mockAdvanceHistoryId.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalPushToken === undefined) delete process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
    else process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN = originalPushToken;
  });

  it('returns 401 when a push token is configured and missing/wrong', async () => {
    process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN = 'secret';
    const response = await POST(pushRequest(pubsubEnvelope({ emailAddress: 'a@b.com', historyId: 1 })) as never);
    expect(response.status).toBe(401);
  });

  it('accepts the push when the token matches', async () => {
    process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN = 'secret';
    mockResolveOwner.mockResolvedValue(OWNER);
    const response = await POST(
      pushRequest(pubsubEnvelope({ emailAddress: 'a@b.com', historyId: 1 }), { token: 'secret' }) as never,
    );
    expect(response.status).toBe(204);
  });

  it('acks (204) a malformed body without processing anything', async () => {
    delete process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
    const response = await POST(pushRequest({ not: 'a pubsub envelope' }) as never);
    expect(response.status).toBe(204);
    expect(mockResolveOwner).not.toHaveBeenCalled();
  });

  it('drops the push (204, no processing) when the mailbox is unknown', async () => {
    delete process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
    mockResolveOwner.mockResolvedValue(undefined);
    const response = await POST(pushRequest(pubsubEnvelope({ emailAddress: 'unknown@x.com', historyId: 5 })) as never);
    expect(response.status).toBe(204);
    expect(mockProcessHistorySince).not.toHaveBeenCalled();
  });

  it('resolves the owner, diffs history since the stored cursor, and advances it', async () => {
    delete process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
    mockResolveOwner.mockResolvedValue(OWNER);

    const response = await POST(pushRequest(pubsubEnvelope({ emailAddress: 'jin@artifactads.com', historyId: 200 })) as never);

    expect(response.status).toBe(204);
    expect(mockResolveOwner).toHaveBeenCalledWith('jin@artifactads.com');
    expect(mockProcessHistorySince).toHaveBeenCalledWith(OWNER, '100');
    expect(mockAdvanceHistoryId).toHaveBeenCalledWith(OWNER, '101');
  });

  it('still acks 204 when history processing throws (Pub/Sub retry would just replay the same diff)', async () => {
    delete process.env.GOOGLE_GMAIL_PUBSUB_PUSH_TOKEN;
    mockResolveOwner.mockResolvedValue(OWNER);
    mockProcessHistorySince.mockRejectedValue(new Error('Gmail API error 500'));

    const response = await POST(pushRequest(pubsubEnvelope({ emailAddress: 'jin@artifactads.com', historyId: 200 })) as never);
    expect(response.status).toBe(204);
  });
});
