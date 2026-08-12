/**
 * Preference gating for the `attest.pending_signature` scope (#1820).
 *
 * The channel-selection gate in POST /notify/api/send is generic (it does not
 * know about individual scopes) — this pins that the new scope rides that
 * existing gate rather than forcing a channel: a disabled email preference for
 * `attest.pending_signature` must suppress the email, and an enabled/absent
 * preference must send it using the real (unmocked) template.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate, mockSendEmail } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockSelectLimit = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  const mockSendEmail = vi.fn().mockResolvedValue(undefined);
  return { mockInsertValues, mockSelectLimit, mockUpdateWhere, mockDbUpdate, mockSendEmail };
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
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
  // Unused by the attest.pending_signature template itself, but templates.ts
  // imports it at module scope (for other templates) so it must exist here.
  buildPublicUrlAbsolute: () => 'https://test.imajin.ai',
  // The real (unmocked) emailWrapper from @imajin/email reads this at render time.
  APP_DISPLAY_NAME: 'Imajin',
}));

vi.mock('nanoid', () => ({ nanoid: () => 'abcdefgh12345678' }));

vi.mock('@imajin/logger', () => ({
  withLogger: (
    _service: string,
    handler: (req: unknown, ctx: unknown) => Promise<Response>,
  ) => (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, correlationId: 'cor_test' }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/email', async () => {
  // Preserve the real emailWrapper/renderBroadcastEmail/stripHtml — the real
  // (unmocked) template under test calls these; only sendEmail is stubbed.
  const actual = await vi.importActual<typeof import('@imajin/email')>('@imajin/email');
  return { ...actual, sendEmail: mockSendEmail };
});

vi.mock('@/src/lib/notify/ws-push', () => ({
  buildNotificationFrame: () => ({}),
  pushNotificationToDid: vi.fn().mockResolvedValue(false),
}));

// The real templates module (NOT mocked) — this is what proves the new scope's
// email template is actually reachable through the send route.
import { POST } from '../route';

const RECIPIENT = 'did:imajin:bob';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body: unknown): RouteRequest {
  const headers = new Headers();
  headers.set('x-webhook-secret', 'notify-webhook-secret');
  return { headers, json: async () => body } as unknown as RouteRequest;
}

function pendingSignatureBody() {
  return {
    to: RECIPIENT,
    scope: 'attest.pending_signature',
    data: { attestationId: 'att_001', type: 'delivery.receipt', email: 'bob@example.com' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_WEBHOOK_SECRET = 'notify-webhook-secret';
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDbUpdate.mockImplementation(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) }));
  mockSendEmail.mockResolvedValue(undefined);
});

describe('attest.pending_signature — default-on preferences', () => {
  it('sends the email using the real template when no preference row exists', async () => {
    mockSelectLimit.mockResolvedValueOnce([]); // no row → default email+inapp on

    const res = await POST(makeReq(pendingSignatureBody()));

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(call.to).toBe('bob@example.com');
    expect(call.subject).toContain('delivery.receipt');
  });
});

describe('attest.pending_signature — recipient disabled email', () => {
  it('does not send an email when the recipient disabled email for this scope', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: true }]);

    const res = await POST(makeReq(pendingSignatureBody()));

    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('still writes the in-app notification row even when email is disabled', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ email: false, inapp: true }]);

    await POST(makeReq(pendingSignatureBody()));

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const row = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(row.scope).toBe('attest.pending_signature');
  });
});
