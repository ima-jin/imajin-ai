import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), requireAuth: vi.fn(), isEventOrganizer: vi.fn(), getVaultInternalApiKey: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth, resolveActingDid: (identity: { id: string }) => identity.id,
  getVaultInternalApiKey: mocks.getVaultInternalApiKey,
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@/src/lib/organizer', () => ({ isEventOrganizer: mocks.isEventOrganizer }));
vi.mock('@/src/lib/ticket-holding', () => ({ holdingTicketStatuses: () => ['valid'] }));
vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://events.test',
  eventUrl: (base: string, id: string) => `${base}/${id}`,
}));

import { POST } from '../../app/api/events/[id]/message/route';

const callRoute = () => POST(new NextRequest('https://events.test/api/events/test/message', {
  method: 'POST', body: JSON.stringify({ subject: 'Update', markdown: 'See you there' }),
}), { params: Promise.resolve({ id: 'test-event' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockReset();
  vi.stubEnv('NOTIFY_WEBHOOK_SECRET', '');
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:test-organizer' } });
  mocks.isEventOrganizer.mockResolvedValue({ authorized: true });
  mocks.getVaultInternalApiKey.mockReturnValue('fake-vault-test-only');
  mocks.sql.mockResolvedValueOnce([{ title: 'Event', image_url: null }])
    .mockResolvedValueOnce([{ owner_did: 'did:imajin:test-attendee' }]);
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ email: 'organizer@example.test' }))
    .mockResolvedValueOnce(Response.json({ sent: 1, skipped: 0, errors: 0 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('organizer contact and broadcast vault credentials', () => {
  it('uses only vault Bearer auth for contact and broadcast, preserving organizer replyTo without shared env', async () => {
    expect((await callRoute()).status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(1,
      'https://kernel.test/auth/api/identity/did%3Aimajin%3Atest-organizer/contact',
      { headers: { Authorization: 'Bearer fake-vault-test-only' }, cache: 'no-store', redirect: 'error' });
    const [, broadcast] = vi.mocked(fetch).mock.calls[1];
    expect(broadcast?.headers).toEqual({
      'Content-Type': 'application/json', Authorization: 'Bearer fake-vault-test-only',
    });
    expect(JSON.parse(broadcast?.body as string)).toMatchObject({
      replyTo: 'organizer@example.test', dids: ['did:imajin:test-attendee'], subject: 'Event: Update',
    });
  });

  it.each([401, 403])('logs contact rejection %s with no unauthorized downgrade/retry', async (status) => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(Response.json({ sent: 1, skipped: 0, errors: 0 }));
    expect((await callRoute()).status).toBe(200);
    expect(mocks.log.warn).toHaveBeenCalledWith({ status }, '[message] Organizer contact lookup rejected');
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, init] = vi.mocked(fetch).mock.calls[1];
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('replyTo');
    expect(init?.headers).not.toHaveProperty('x-webhook-secret');
  });

  it('does not downgrade to an environment secret when the boot vault key is absent', async () => {
    vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-legacy-test-only');
    mocks.getVaultInternalApiKey.mockReturnValue(undefined);
    expect((await callRoute()).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('logs a contact network failure while still broadcasting without replyTo', async () => {
    vi.mocked(fetch).mockReset()
      .mockRejectedValueOnce(new Error('test contact unavailable'))
      .mockResolvedValueOnce(Response.json({ sent: 1, skipped: 0, errors: 0 }));
    expect((await callRoute()).status).toBe(200);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      { err: 'Error: test contact unavailable' }, '[message] Failed to resolve organizer email for reply-to');
  });

  it('never retries a rejected broadcast using legacy credentials', async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json({ email: 'organizer@example.test' }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    expect((await callRoute()).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
