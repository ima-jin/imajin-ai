/**
 * Tests for POST /notify/api/send — the WebSocket push added in #1644.
 *
 * The notification row was always written; what this pins is that creating one
 * also fans it out to any socket the recipient has open, that the frame carries
 * the persisted id/scope/title/body/data so a client never has to read the row
 * back, and that the push is subordinate to the request: a disabled in-app
 * preference suppresses it, and a failed push still returns 200.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  return { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate };
});

vi.mock('@/src/db', () => ({
  db: {
    insert: vi.fn(() => ({ values: mockInsertValues })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) })),
    update: mockDbUpdate,
  },
  notifications: {},
  preferences: { did: 'did', scope: 'scope' },
  identities: { id: 'id', contactEmail: 'contact_email' },
  profiles: { did: 'did', contactEmail: 'contact_email' },
  // #1854: resolveRecipientEmail's new auth.credentials fallback.
  credentials: { did: 'did', type: 'type', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'abcdefgh12345678' }));

vi.mock('@imajin/logger', () => ({
  withLogger: (
    _service: string,
    handler: (req: unknown, ctx: unknown) => Promise<Response>,
  ) => (req: unknown) =>
    handler(req, {
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      correlationId: 'cor_test',
    }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/email', () => ({ sendEmail: vi.fn() }));

vi.mock('@/src/lib/notify/templates', () => ({ getTemplate: vi.fn(() => undefined) }));

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock('@/src/lib/notify/ws-push', async () => {
  // The frame builder is a pure projection, so the real one is used — that keeps
  // the assertions below about the actual wire shape rather than a stand-in.
  const actual = await vi.importActual<typeof import('@/src/lib/notify/ws-push')>(
    '@/src/lib/notify/ws-push',
  );
  return { buildNotificationFrame: actual.buildNotificationFrame, pushNotificationToDid: mockPush };
});

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';
import { sendEmail } from '@imajin/email';
import { getTemplate } from '@/src/lib/notify/templates';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RECIPIENT = 'did:imajin:veteze';
const WEBHOOK_SECRET = 'notify-webhook-secret';
const NOTIFICATION_ID = 'ntf_abcdefgh12345678';
const EMAIL_SCOPE = 'test.email.scope';

/** A template with an email leg configured, so resolveAndSendEmail is exercised. */
function emailTemplate() {
  return {
    scope: EMAIL_SCOPE,
    urgency: 'normal' as const,
    title: () => 'Test notification',
    body: () => 'Test body',
    email: {
      subject: () => 'Test subject',
      html: () => '<p>Test</p>',
    },
  };
}

function emailScopeBody(overrides: Record<string, unknown> = {}) {
  return { to: RECIPIENT, scope: EMAIL_SCOPE, data: {}, ...overrides };
}

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body: unknown, opts: { secret?: string | null } = {}): RouteRequest {
  const headers = new Headers();
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret;
  if (secret !== null) headers.set('x-webhook-secret', secret);
  return {
    headers,
    json: async () => body,
  } as unknown as RouteRequest;
}

function warpCompletionBody() {
  return {
    to: RECIPIENT,
    scope: 'warp.run.completed',
    title: 'Warp run completed',
    body: 'Run SUCCEEDED: Nightly',
    data: { runId: '019f9990-2a46-7552-b177-3a23b17eef2e', state: 'SUCCEEDED' },
  };
}

/** The frame the WS push was called with. */
function pushedFrame(): Record<string, unknown> {
  return mockPush.mock.calls[0][1] as Record<string, unknown>;
}

/** The values written to the notifications table. */
function insertedRow(): Record<string, unknown> {
  return mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
}

/** The channels recorded on the row after delivery. */
function recordedChannels(): string[] {
  const set = mockDbUpdate.mock.results[0].value.set as ReturnType<typeof vi.fn>;
  return (set.mock.calls[0][0] as { channelsSent: string[] }).channelsSent;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  mockInsertValues.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([]); // no preferences row → email + inapp default on
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDbUpdate.mockImplementation(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  mockPush.mockResolvedValue(true);
  vi.mocked(getTemplate).mockReturnValue(undefined);
  vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: 'msg_default' });
});

// ─── WebSocket push (#1644) ──────────────────────────────────────────────────

describe('WebSocket push on notification create', () => {
  it('pushes a notification frame to the recipient DID', async () => {
    const res = await POST(makeReq(warpCompletionBody()));

    expect(res.status).toBe(200);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toBe(RECIPIENT);
    expect(pushedFrame()).toMatchObject({
      type: 'notification',
      id: NOTIFICATION_ID,
      scope: 'warp.run.completed',
      title: 'Warp run completed',
      body: 'Run SUCCEEDED: Nightly',
      data: { runId: '019f9990-2a46-7552-b177-3a23b17eef2e', state: 'SUCCEEDED' },
    });
  });

  it('pushes the same id the response returns, so a client can mark it read', async () => {
    const res = await POST(makeReq(warpCompletionBody()));

    expect(await res.json()).toMatchObject({ id: NOTIFICATION_ID, sent: true });
    expect(pushedFrame().id).toBe(NOTIFICATION_ID);
  });

  it('pushes the createdAt the row was written with', async () => {
    await POST(makeReq(warpCompletionBody()));

    const written = insertedRow().createdAt as Date;
    expect(written).toBeInstanceOf(Date);
    expect(pushedFrame().createdAt).toBe(written.toISOString());
  });

  it('pushes only after the row exists, so a woken client can read it back', async () => {
    const order: string[] = [];
    mockInsertValues.mockImplementationOnce(async () => {
      order.push('insert');
    });
    mockPush.mockImplementationOnce(async () => {
      order.push('push');
      return true;
    });

    await POST(makeReq(warpCompletionBody()));

    expect(order).toEqual(['insert', 'push']);
  });

  it('records the ws channel when a socket received the frame', async () => {
    mockPush.mockResolvedValueOnce(true);

    await POST(makeReq(warpCompletionBody()));

    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it('records inapp only when the recipient had no socket open', async () => {
    mockPush.mockResolvedValueOnce(false);

    await POST(makeReq(warpCompletionBody()));

    expect(recordedChannels()).toEqual(['inapp']);
  });

  it('does not push when the recipient disabled in-app for the scope', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: false }]);

    const res = await POST(makeReq(warpCompletionBody()));

    expect(res.status).toBe(200);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('falls back to the scope as the title when no template or title is given', async () => {
    await POST(makeReq({ to: RECIPIENT, scope: 'warp.run.timeout' }));

    expect(pushedFrame()).toMatchObject({
      scope: 'warp.run.timeout',
      title: 'warp.run.timeout',
      body: null,
      data: {},
    });
  });
});

// ─── The push never fails the send ───────────────────────────────────────────

describe('push failure isolation', () => {
  it('still returns 200 when the push reports failure', async () => {
    mockPush.mockResolvedValueOnce(false);

    const res = await POST(makeReq(warpCompletionBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: NOTIFICATION_ID, sent: true });
  });
});

// ─── Guards unchanged ────────────────────────────────────────────────────────

describe('existing guards still hold', () => {
  it('returns 401 without pushing when the webhook secret is wrong', async () => {
    const res = await POST(makeReq(warpCompletionBody(), { secret: 'wrong' }));

    expect(res.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('returns 400 without pushing when required fields are missing', async () => {
    const res = await POST(makeReq({ scope: 'warp.run.completed' }));

    expect(res.status).toBe(400);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ─── Honest email delivery outcome (#1854) ──────────────────────────────────

describe('email delivery honesty (#1854)', () => {
  beforeEach(() => {
    vi.mocked(getTemplate).mockReturnValue(emailTemplate());
  });

  it('resolves the email from the payload without touching the db, and reports sent + emailResolved true', async () => {
    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: true, emailResolved: true });
    expect(body.error).toBeUndefined();
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'payload@example.com' }),
    );
    expect(recordedChannels()).toContain('email');
  });

  it('falls back to profiles.contactEmail when the payload has no email', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([]) // preferences: no row
      .mockResolvedValueOnce([{ contactEmail: 'profile@example.com' }]); // profiles hit

    const res = await POST(makeReq(emailScopeBody()));
    const body = await res.json();

    expect(body).toMatchObject({ sent: true, emailResolved: true });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'profile@example.com' }),
    );
  });

  it('falls back to identities.contactEmail when profiles has none', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([]) // preferences
      .mockResolvedValueOnce([]) // profiles miss
      .mockResolvedValueOnce([{ contactEmail: 'identity@example.com' }]); // identities hit

    const res = await POST(makeReq(emailScopeBody()));
    const body = await res.json();

    expect(body).toMatchObject({ sent: true, emailResolved: true });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'identity@example.com' }),
    );
  });

  it('falls back to auth.credentials(type=email) when neither profiles nor identities has one', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([]) // preferences
      .mockResolvedValueOnce([]) // profiles miss
      .mockResolvedValueOnce([]) // identities miss
      .mockResolvedValueOnce([{ value: 'credential@example.com' }]); // auth.credentials hit

    const res = await POST(makeReq(emailScopeBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: true, emailResolved: true });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'credential@example.com' }),
    );
    expect(recordedChannels()).toContain('email');
  });

  it('returns sent: false, emailResolved: false and a caller-safe error when no email resolves anywhere', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([]) // preferences
      .mockResolvedValueOnce([]) // profiles miss
      .mockResolvedValueOnce([]) // identities miss
      .mockResolvedValueOnce([]); // auth.credentials miss

    const res = await POST(makeReq(emailScopeBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      id: NOTIFICATION_ID,
      sent: false,
      emailResolved: false,
      error: 'No email address found for recipient',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordedChannels()).not.toContain('email');
  });

  it('returns sent: false with emailResolved: true when the provider reports a failure', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false, error: 'Postal 500: Internal Server Error' });

    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      id: NOTIFICATION_ID,
      sent: false,
      emailResolved: true,
      error: 'Email delivery failed',
    });
    expect(recordedChannels()).not.toContain('email');
  });

  it('returns sent: false with emailResolved: true when sendEmail throws', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('network error'));

    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: false, emailResolved: true, error: 'Email delivery failed' });
  });

  it('does not attempt email and omits emailResolved when the recipient has email disabled for the scope', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: true }]);

    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: NOTIFICATION_ID, sent: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not attempt email and keeps sent: true when the resolved scope has no email template', async () => {
    vi.mocked(getTemplate).mockReturnValue(undefined);

    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: NOTIFICATION_ID, sent: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
