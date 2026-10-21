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
const { mockEmailSql } = vi.hoisted(() => ({ mockEmailSql: vi.fn() }));
vi.mock('@imajin/db', () => ({
  getClient: () => ({
    begin: async (_isolation: string, callback: (tx: unknown) => Promise<unknown>) => callback({ unsafe: mockEmailSql }),
  }),
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  return { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate };
});
describe('connection request verified email policy (#3013)', () => {
  const scope = 'connection:request-received';
  function requestBody() {
    return { to: RECIPIENT, scope, data: { fromDid: 'did:imajin:requester', email: 'malicious@example.com', inviteId: 'inv_request' } };
  }
  beforeEach(() => {
    vi.mocked(getTemplate).mockReturnValue({ ...emailTemplate(), scope });
  });
  function verifiedRecipient() {
    mockEmailSql
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([{ value: 'verified@example.com' }])
      .mockResolvedValueOnce([]); // no prior successful email
  }

  it('strips payload email from stored/WS data and sends only to a verified credential', async () => {
    verifiedRecipient();
    const res = await POST(makeReq(requestBody()));
    expect(await res.json()).toMatchObject({ sent: true, emailResolved: true });
    expect(insertedRow().data).toEqual({ fromDid: 'did:imajin:requester', inviteId: 'inv_request' });
    expect(pushedFrame().data).toEqual(insertedRow().data);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'verified@example.com', purpose: 'notifications' }));
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(mockSelectLimit).toHaveBeenCalledOnce(); // preferences only, never profiles/identities
    expect(mockEmailSql.mock.calls.at(-1)?.[0]).toContain('UPDATE notify.notifications');
    expect(recordedChannels()).toEqual(['inapp', 'ws']); // email appended under lock, never overwritten
  });

  it.each(['absent', 'unverified'])('keeps in-app and never trusts payload/profile email when credential is %s', async () => {
    const res = await POST(makeReq(requestBody()));
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockEmailSql.mock.calls[1][0]).toContain('verified_at IS NOT NULL');
    expect(mockSelectLimit).toHaveBeenCalledOnce();
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it('respects email opt-out without losing in-app notification', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: true }]);
    await POST(makeReq(requestBody()));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockEmailSql).not.toHaveBeenCalled();
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it.each([
    { success: false, error: 'provider unavailable' },
    { success: false, error: 'mail_not_configured' },
  ])('does not record email when delivery fails: %s', async (result) => {
    verifiedRecipient();
    vi.mocked(sendEmail).mockResolvedValueOnce(result);
    const res = await POST(makeReq(requestBody()));
    expect(await res.json()).toMatchObject({ sent: false, emailResolved: true });
    expect(mockEmailSql).toHaveBeenCalledTimes(3);
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it('isolates thrown provider and database errors from the in-app leg', async () => {
    verifiedRecipient();
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('provider unavailable'));
    const res = await POST(makeReq(requestBody()));
    expect(await res.json()).toMatchObject({ sent: false });
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
    mockEmailSql.mockRejectedValueOnce(new Error('database unavailable'));
    const next = await POST(makeReq(requestBody()));
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ sent: false, error: 'Email delivery unavailable' });
  });

  it('skips duplicate email while retaining one new notification row', async () => {
    mockEmailSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ value: 'verified@example.com' }]).mockResolvedValueOnce([{ exists: 1 }]);
    await POST(makeReq(requestBody()));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it('does not enter email policy without an email template', async () => {
    vi.mocked(getTemplate).mockReturnValue(undefined);
    await POST(makeReq(requestBody()));
    expect(mockEmailSql).not.toHaveBeenCalled();
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });
});
describe('Reach principal in-app and phone delivery (#2588)', () => {
  function reachBody() {
    return {
      to: RECIPIENT,
      scope: 'agent.reach.delivered',
      title: 'Untrusted supplied title',
      body: 'PRIVATE supplied body',
      data: {
        reachId: 'reach_123&injected=true',
        requesterDid: 'did:imajin:foreign-agent',
        message: 'PRIVATE message',
        replyHandle: 'PRIVATE handle',
        onBehalfOf: { platform: 'foreign', externalRef: 'opaque', selfDescription: 'Unverified' },
        signature: { keyId: 'pub', alg: 'ed25519', sig: 'sig' },
        url: 'https://untrusted.example',
      },
    };
  }

  it('defaults on without a new preference row and preserves full data in-app only', async () => {
    const body = reachBody();
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(insertedRow()).toMatchObject({ recipientDid: RECIPIENT, data: body.data });
    expect(mockPush).toHaveBeenCalledWith(RECIPIENT, expect.objectContaining({ data: body.data }));
    expect(mockPhonePush).toHaveBeenCalledTimes(1);
    expect(mockPhonePush).toHaveBeenCalledWith(RECIPIENT, {
      title: 'New Reach message',
      body: 'A Reach sender sent you a message.',
      url: '/jin?lane=inbox&reachId=reach_123%26injected%3Dtrue',
    });
    expect(JSON.stringify(mockPhonePush.mock.calls[0])).not.toContain('PRIVATE');
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
  });

  it('respects disabled in-app preference for both phone and WS without losing the row', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: false }]);
    await POST(makeReq(reachBody()));
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockPhonePush).not.toHaveBeenCalled();
  });
  it('persists and pushes the original signed reply only to its principal, without a phone preview', async () => {
    const data = {
      eventType: 'agent.reach.replied', issuer: RECIPIENT, subject: RECIPIENT,
      principalDid: RECIPIENT, requesterDid: 'did:imajin:foreign-agent',
      reachId: 'reach_reply', message: 'PRIVATE reply\n  unchanged',
      signature: { keyId: 'public-fixture', alg: 'ed25519', sig: 'public-signature-fixture' },
    };
    const res = await POST(makeReq({
      to: RECIPIENT, scope: 'agent.reach.replied', title: 'Reach reply sent',
      body: 'Your signed Reach reply is available', data,
    }));
    expect(res.status).toBe(200);
    expect(insertedRow()).toMatchObject({ recipientDid: RECIPIENT, scope: 'agent.reach.replied', data });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(RECIPIENT, expect.objectContaining({ data }));
    expect(recordedChannels()).toEqual(['inapp', 'ws']);
    expect(mockPhonePush).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not phone-push legacy events', async () => {
    await POST(makeReq(warpCompletionBody()));
    expect(mockPhonePush).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 12])('does not phone-push a missing or invalid reachId (%s)', async (reachId) => {
    const body = reachBody();
    await POST(makeReq({ ...body, data: { ...body.data, reachId } }));
    expect(mockPhonePush).not.toHaveBeenCalled();
  });
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

vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: vi.fn() }));

vi.mock('@/src/lib/notify/template-store', () => ({ getTemplate: vi.fn(() => undefined) }));

// #2059 — operator-approvals.ts imports node-identity.ts, which calls
// getClient() at module scope (requires DATABASE_URL); stub these out so
// importing the route never needs a real DB/operator config. Hoisted and
// mock-fn-backed (not inline stubs) so the dedicated describe block below
// can control their return values per test.
const { mockGetOperatorDid, mockValidateApprovalRequestedPayload, mockRecordApprovalRequested } = vi.hoisted(() => ({
  mockGetOperatorDid: vi.fn(),
  mockValidateApprovalRequestedPayload: vi.fn(),
  mockRecordApprovalRequested: vi.fn(),
}));

vi.mock('@/src/lib/notify/operator-approvals', () => ({
  OPERATOR_APPROVAL_REQUESTED_SCOPE: 'operator.approval.requested',
  getOperatorDid: mockGetOperatorDid,
  validateApprovalRequestedPayload: mockValidateApprovalRequestedPayload,
}));

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: mockRecordApprovalRequested,
}));

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
const { mockPhonePush } = vi.hoisted(() => ({ mockPhonePush: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/src/lib/notify/web-push', () => ({
  pushWebNotificationToOperator: mockPhonePush,
}));

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
import { sendKernelEmail as sendEmail } from '@/src/lib/mail/send';
import { getTemplate } from '@/src/lib/notify/template-store';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RECIPIENT = 'did:imajin:veteze';
const WEBHOOK_SECRET = 'fake-vault-internal-key';
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
  if (secret !== null) headers.set('authorization', `Bearer ${secret}`);
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
  mockEmailSql.mockReset().mockResolvedValue([]);
  mockInsertValues.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([]); // no preferences row → email + inapp default on
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDbUpdate.mockImplementation(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  mockPush.mockResolvedValue(true);
  vi.mocked(getTemplate).mockReturnValue(undefined);
  vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: 'msg_default' });
  // #2059 — this suite's other tests never send scope='operator.approval.requested',
  // so rejectInvalidOperatorApprovalRequest short-circuits before touching these;
  // defaults here only matter for the dedicated describe block below.
  mockGetOperatorDid.mockResolvedValue(RECIPIENT);
  mockValidateApprovalRequestedPayload.mockReturnValue({
    ok: true,
    source: 'system-agent',
    kind: 'system-agent:restart',
    detail: null,
    contentHash: null,
  });
  mockRecordApprovalRequested.mockResolvedValue(undefined);
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

  it('preserves the safe post-delivery audit code and forbids retry without claiming audited success', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({
      success: false, messageId: 'provider-private-fixture',
      error: 'mail_audit_failed_after_delivery_do_not_retry',
    });
    const res = await POST(makeReq(emailScopeBody({ data: { email: 'payload@example.com' } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: NOTIFICATION_ID, sent: false, emailResolved: true,
      error: 'mail_audit_failed_after_delivery_do_not_retry',
      retryable: false, deliveredMayHaveOccurred: true,
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

// ─── operator.approval.requested boundary (#2059) ──────────────────────────────────────────
// Shares this file's mocks/fixtures rather than duplicating the whole route
// test apparatus in a separate file (SonarCloud duplicated-lines guard).

const PROPOSAL_ID = 'opap_test123';

function operatorApprovalBody(overrides: Record<string, unknown> = {}) {
  return {
    to: RECIPIENT,
    scope: 'operator.approval.requested',
    data: {
      proposalId: PROPOSAL_ID,
      kind: 'restart',
      summary: 'Restart the gateway to load the updated plugin.',
      keysTouched: ['gateway.plugins.openclaw.version'],
      ...overrides,
    },
  };
}

describe('operator.approval.requested boundary (#2059, generalized #2152)', () => {
  it('accepts a well-formed legacy-kind proposal, stores the notification, and records the normalized lifecycle row', async () => {
    const res = await POST(makeReq(operatorApprovalBody()));

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      operatorDid: RECIPIENT,
      source: 'system-agent',
      kind: 'system-agent:restart',
      summary: 'Restart the gateway to load the updated plugin.',
      keysTouched: ['gateway.plugins.openclaw.version'],
      detail: null,
      contentHash: null,
      notificationId: NOTIFICATION_ID,
      signerDid: null,
    });
  });

  it("captures the requesting agent's signerDid from the payload (#2337)", async () => {
    const SIGNER_DID = 'did:imajin:jin-agent';
    const res = await POST(makeReq(operatorApprovalBody({ signerDid: SIGNER_DID })));

    expect(res.status).toBe(200);
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ signerDid: SIGNER_DID }),
    );
  });

  it('ignores a malformed signerDid (non-string) rather than rejecting the request (#2337)', async () => {
    const res = await POST(makeReq(operatorApprovalBody({ signerDid: 12345 })));

    expect(res.status).toBe(200);
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ signerDid: null }),
    );
  });

  it('records the source-normalized detail and contentHash for an open-vocabulary proposal (#2152)', async () => {
    const detail = { skillName: 'weather-lookup', kind: 'update', scan: 'clean' };
    mockValidateApprovalRequestedPayload.mockReturnValueOnce({
      ok: true,
      source: 'skill-workshop',
      kind: 'skill-workshop:update',
      detail,
      contentHash: 'a'.repeat(64),
    });

    const res = await POST(makeReq(operatorApprovalBody({ source: 'skill-workshop', kind: 'skill-workshop:update', detail, contentHash: 'a'.repeat(64) })));

    expect(res.status).toBe(200);
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'skill-workshop', kind: 'skill-workshop:update', detail, contentHash: 'a'.repeat(64) }),
    );
  });

  it('rejects (400) a payload the validator flags, without touching the db', async () => {
    mockValidateApprovalRequestedPayload.mockReturnValueOnce({ ok: false, error: 'summary must not contain secret values' });

    const res = await POST(makeReq(operatorApprovalBody()));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('summary must not contain secret values');
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects (400) when addressed to a DID other than the configured operator', async () => {
    const res = await POST(makeReq({ ...operatorApprovalBody(), to: 'did:imajin:someone-else' }));

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects (400) when no operator DID is configured on this node at all', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);

    const res = await POST(makeReq(operatorApprovalBody()));

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

// ─── connector proposals notify the OWNER, not the operator (#2723) ──────────────────────

const OWNER_DID = 'did:imajin:eric';

describe('operator.approval.requested delivery addressee (#2723)', () => {
  it.each([
    // [label, source, kind, detail, who the notification must reach]
    ['a github connector proposal reaches its owner', 'github', 'github:mutate', { ownerDid: OWNER_DID, tool: 'github_update_issue' }, OWNER_DID],
    ['another connector write tier reaches its owner', 'google', 'google:write', { ownerDid: OWNER_DID }, OWNER_DID],
    ['a connector-shaped kind with no owner DID stays with the operator', 'github', 'github:mutate', { tool: 'x' }, RECIPIENT],
    ['a node-level kind stays with the operator', 'system-agent', 'system-agent:restart', null, RECIPIENT],
  ])('%s — persisted notification and WS push', async (_label, source, kind, detail, expectedRecipient) => {
    mockValidateApprovalRequestedPayload.mockReturnValueOnce({ ok: true, source, kind, detail, contentHash: 'a'.repeat(64) });

    const res = await POST(makeReq(operatorApprovalBody({ source, kind, detail, contentHash: 'a'.repeat(64) })));

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ recipientDid: expectedRecipient }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toBe(expectedRecipient);
    // The approval row itself is resolved by recordApprovalRequested from the operator DID the webhook was addressed to.
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith(expect.objectContaining({ operatorDid: RECIPIENT, kind, detail }));
  });
});

vi.mock('@/src/lib/vault/internal-secret', () => ({ getInternalSecret: vi.fn(async () => 'fake-vault-internal-key') }));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: vi.fn(async () => null) }));
