/**
 * Synchronous kernel handlers for registry/notify/connections/chat/usage/profile (#2564).
 *
 * These handlers do no awaiting, so Sonar S7503 forbids `async` on them. This
 * suite pins the contract that must survive the `async` removal:
 *  - OPTIONS preflights answer 204 with CORS headers, synchronously;
 *  - health/spec/logout/specs handlers return their Response synchronously.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'node:path';

// Several routes import the db client at module load, which only checks that the
// URL is set (it connects lazily). None of these handlers touches the database.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
});

type Handler = (request: NextRequest) => Response | Promise<Response>;
type RouteModule = { OPTIONS?: Handler; GET?: Handler; POST?: Handler };

const optionsRoutes: Record<string, () => Promise<RouteModule>> = {
  "chat/conversations/unread": () => import('@/app/chat/api/conversations/unread/route'),
  "chat/d/[did]/context": () => import('@/app/chat/api/d/[did]/context/route'),
  "chat/d/[did]/members/[memberDid]": () => import('@/app/chat/api/d/[did]/members/[memberDid]/route'),
  "chat/d/[did]/members/leave": () => import('@/app/chat/api/d/[did]/members/leave/route'),
  "chat/d/[did]/members": () => import('@/app/chat/api/d/[did]/members/route'),
  "chat/d/[did]/messages/[msgId]/reactions": () => import('@/app/chat/api/d/[did]/messages/[msgId]/reactions/route'),
  "chat/d/[did]/messages/[msgId]": () => import('@/app/chat/api/d/[did]/messages/[msgId]/route'),
  "chat/d/[did]/messages": () => import('@/app/chat/api/d/[did]/messages/route'),
  "chat/d/[did]/read": () => import('@/app/chat/api/d/[did]/read/route'),
  "chat/ws-token": () => import('@/app/chat/api/ws-token/route'),
  "connections/connections": () => import('@/app/connections/api/connections/route'),
  "connections/connections/status/[did]": () => import('@/app/connections/api/connections/status/[did]/route'),
  "connections/connectors/[id]/spend": () => import('@/app/connections/api/connectors/[id]/spend/route'),
  "connections/connectors/[id]/telemetry": () => import('@/app/connections/api/connectors/[id]/telemetry/route'),
  "connections/connectors/status": () => import('@/app/connections/api/connectors/status/route'),
  "connections/groups": () => import('@/app/connections/api/groups/route'),
  "connections/invites/[code]": () => import('@/app/connections/api/invites/[code]/route'),
  "connections/nicknames/resolve": () => import('@/app/connections/api/nicknames/resolve/route'),
  "connections/telemetry": () => import('@/app/connections/api/telemetry/route'),
  "notify/broadcast": () => import('@/app/notify/api/broadcast/route'),
  "notify/health": () => import('@/app/notify/api/health/route'),
  "notify/interest": () => import('@/app/notify/api/interest/route'),
  "notify/internal/operator-approvals/applied": () => import('@/app/notify/api/internal/operator-approvals/applied/route'),
  "notify/internal/operator-approvals/outcome": () => import('@/app/notify/api/internal/operator-approvals/outcome/route'),
  "notify/notifications/[id]/read": () => import('@/app/notify/api/notifications/[id]/read/route'),
  "notify/notifications/read-all": () => import('@/app/notify/api/notifications/read-all/route'),
  "notify/notifications": () => import('@/app/notify/api/notifications/route'),
  "notify/notifications/unread": () => import('@/app/notify/api/notifications/unread/route'),
  "notify/preferences/[scope]": () => import('@/app/notify/api/preferences/[scope]/route'),
  "notify/preferences": () => import('@/app/notify/api/preferences/route'),
  "notify/send": () => import('@/app/notify/api/send/route'),
  "profile/contact/verify-email": () => import('@/app/profile/api/contact/verify-email/route'),
  "profile/presence/[did]": () => import('@/app/profile/api/presence/[did]/route'),
  "profile/profile/[id]/contact-visibility": () => import('@/app/profile/api/profile/[id]/contact-visibility/route'),
  "profile/profile/[id]": () => import('@/app/profile/api/profile/[id]/route'),
  "profile/resolve": () => import('@/app/profile/api/resolve/route'),
  "registry/bump/activate": () => import('@/app/registry/api/bump/activate/route'),
  "registry/bump/confirm": () => import('@/app/registry/api/bump/confirm/route'),
  "registry/bump/deactivate": () => import('@/app/registry/api/bump/deactivate/route'),
  "registry/bump/event": () => import('@/app/registry/api/bump/event/route'),
  "registry/bump/nodes": () => import('@/app/registry/api/bump/nodes/route'),
  "registry/identity/[did]": () => import('@/app/registry/api/identity/[did]/route'),
  "registry/interests/[scope]": () => import('@/app/registry/api/interests/[scope]/route'),
  "registry/interests": () => import('@/app/registry/api/interests/route'),
  "registry/preferences/[did]/interests/[scope]": () => import('@/app/registry/api/preferences/[did]/interests/[scope]/route'),
  "registry/preferences/[did]": () => import('@/app/registry/api/preferences/[did]/route'),
  "registry/specs/[service]": () => import('@/app/registry/api/specs/[service]/route'),
  "registry/specs": () => import('@/app/registry/api/specs/route'),
  "usage/audit/sessions/[sessionId]": () => import('@/app/usage/api/audit/sessions/[sessionId]/route'),
  "usage/billed": () => import('@/app/usage/api/billed/route'),
  "usage/emitters": () => import('@/app/usage/api/emitters/route'),
  "usage/incurred": () => import('@/app/usage/api/incurred/route'),
  "usage/receipts/extract": () => import('@/app/usage/api/receipts/extract/route'),
  "usage/receipts": () => import('@/app/usage/api/receipts/route'),
  "usage/reconciliation": () => import('@/app/usage/api/reconciliation/route'),
  "usage/rollup/[did]/latest": () => import('@/app/usage/api/rollup/[did]/latest/route'),
  "usage/rollups": () => import('@/app/usage/api/rollups/route'),
  "usage/summary": () => import('@/app/usage/api/summary/route'),
};

function makeRequest(method: string, origin = 'https://test.imajin.ai'): NextRequest {
  return new NextRequest('https://test.imajin.ai/api/x', { method, headers: { origin } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OPTIONS preflight handlers', () => {
  it.each(Object.keys(optionsRoutes))('%s responds 204 with CORS headers, synchronously', async (name) => {
    const { OPTIONS } = await optionsRoutes[name]();
    expect(typeof OPTIONS).toBe('function');

    const res = OPTIONS!(makeRequest('OPTIONS'));

    expect(res).not.toBeInstanceOf(Promise);
    expect((res as Response).status).toBe(204);
    expect((res as Response).headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
    expect((res as Response).headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('blanks Access-Control-Allow-Origin for a disallowed origin', async () => {
    const { OPTIONS } = await optionsRoutes['chat/ws-token']();

    const res = OPTIONS!(makeRequest('OPTIONS', 'https://evil.example.com')) as Response;

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
  });
});

describe('health handlers', () => {
  it.each([
    ['chat', () => import('@/app/chat/api/health/route')],
    ['connections', () => import('@/app/connections/api/health/route')],
    ['profile', () => import('@/app/profile/api/health/route')],
    ['registry', () => import('@/app/registry/api/health/route')],
  ] as const)('%s returns ok synchronously', async (service, load) => {
    const { GET } = await load();

    const res = (GET as () => Response)();

    expect(res).not.toBeInstanceOf(Promise);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service });
  });
});

describe('spec handlers', () => {
  it.each([
    ['chat', () => import('@/app/chat/api/spec/route')],
    ['connections', () => import('@/app/connections/api/spec/route')],
    ['notify', () => import('@/app/notify/api/spec/route')],
    ['profile', () => import('@/app/profile/api/spec/route')],
    ['registry', () => import('@/app/registry/api/spec/route')],
    ['usage', () => import('@/app/usage/api/spec/route')],
  ] as const)('%s serves its yaml spec synchronously', async (_name, load) => {
    // The handlers read api-spec/*.yaml relative to the kernel app root.
    vi.spyOn(process, 'cwd').mockReturnValue(path.resolve(__dirname, '..'));
    const { GET } = await load();

    const res = (GET as () => Response)();

    expect(res).not.toBeInstanceOf(Promise);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});

describe('logout handlers', () => {
  it.each([
    ['connections', () => import('@/app/connections/api/auth/logout/route')],
    ['profile', () => import('@/app/profile/api/auth/logout/route')],
  ] as const)('%s clears the session cookie synchronously', async (_name, load) => {
    const { POST } = await load();

    const res = (POST as Handler)(makeRequest('POST')) as Response;

    expect(res).not.toBeInstanceOf(Promise);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });
});

describe('registry specs listing', () => {
  it('lists services synchronously with CORS headers', async () => {
    const { GET } = await import('@/app/registry/api/specs/route');

    const res = (GET as Handler)(makeRequest('GET')) as Response;

    expect(res).not.toBeInstanceOf(Promise);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
    const body = await res.json();
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services.length).toBeGreaterThan(0);
  });
});
