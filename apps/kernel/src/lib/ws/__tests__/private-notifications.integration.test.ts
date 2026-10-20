import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { WebSocket as Socket } from 'ws';
vi.mock('@imajin/db', () => ({
  getClient: () => async (strings: TemplateStringsArray) => strings.join('').includes('RETURNING seq')
    ? [{ seq: '2979' }]
    : [{ agent_did: 'did:imajin:agent', grant_id: 'grant_approvals', audience: { type: 'all' } }],
}));

import { deliverToSubscribers } from '../../../../../../packages/bus/src/subscriptions';

const { WebSocket } = require('ws');
const { setupWebSocket, setupBroadcastRoute } = require('../../../../ws-server');
const networkFetch = globalThis.fetch;
const PRINCIPAL = 'did:imajin:principal';
const AGENT = 'did:imajin:agent';
// Public, inert fixture only; no real credentials or cryptographic keys.
const FIXTURE_KEY = 'public-ws-integration-fixture';

type Frame = Record<string, unknown>;
type Client = { ws: Socket; frames: Frame[] };
type Call = { path: string; body: Record<string, unknown> };
let server: Server;
let origin: string;
let calls: Call[];
let clients: Client[];
let timer: ReturnType<typeof setInterval>;
let allowed: boolean;
let backlog: Frame[];
let verifyPrivate: (() => Promise<Response>) | undefined;

function notification(id: string, scope = 'agent.reach.delivered'): Frame {
  return {
    type: 'notification', id, scope, title: 'Reach', body: 'New Reach message',
    data: {
      eventType: scope, issuer: AGENT, subject: PRINCIPAL,
      payload: { message: 'Original\n  envelope', signature: { alg: 'ed25519', sig: 'public-signature-fixture' } },
    },
  };
}

async function localApi(url: string, init?: RequestInit): Promise<Response> {
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ path, body });
  if (path.endsWith('/session')) {
    const cookie = (init?.headers as Record<string, string>).Cookie;
    return Response.json({ did: cookie.split('=').slice(1).join('=') });
  }
  if (path.endsWith('/verify-delegation')) {
    if (body.purpose === 'private-reach') {
      if (verifyPrivate) return verifyPrivate();
      return Response.json({ allowed });
    }
    return Response.json({ allowed: true });
  }
  if (path.endsWith('/backlog')) {
    return Response.json({ frames: body.privateReachOnly ? backlog : [], truncated: false });
  }
  return Response.json({ ok: true });
}

async function connect(did: string): Promise<Client> {
  const ws: Socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    headers: { Cookie: `imajin_session=${did}` },
  });
  const client = { ws, frames: [] as Frame[] };
  ws.on('message', (bytes) => client.frames.push(JSON.parse(bytes.toString())));
  clients.push(client);
  await vi.waitFor(() => expect(client.frames.some((frame) => frame.type === 'connected')).toBe(true));
  return client;
}

async function command(client: Client, frame: Frame, responseType: string) {
  const start = client.frames.length;
  client.ws.send(JSON.stringify(frame));
  await vi.waitFor(() => expect(client.frames.slice(start).some((item) => item.type === responseType)).toBe(true));
}

async function register(client: Client) {
  await command(client, { type: 'register_also', did: PRINCIPAL }, 'registered_also');
}

async function push(event: Frame, key = FIXTURE_KEY) {
  return networkFetch(`${origin}/chat/api/internal/did-push`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
    body: JSON.stringify({ targetDid: PRINCIPAL, event }),
  });
}

beforeEach(async () => {
  calls = [];
  clients = [];
  allowed = true;
  backlog = [];
  verifyPrivate = undefined;
  vi.stubEnv('AUTH_INTERNAL_API_KEY', FIXTURE_KEY);
  vi.stubEnv('IMAJIN_ENV', 'prod');
  vi.stubGlobal('fetch', vi.fn(localApi));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const realInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
    timer = realInterval(...args);
    return timer;
  });
  server = createServer();
  setupBroadcastRoute(server);
  setupWebSocket(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  clearInterval(timer);
  for (const { ws } of clients) {
    if (ws.readyState === 3) continue;
    const closed = once(ws, 'close');
    ws.terminate();
    await closed;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Client close can precede the server's close callback for upgraded sockets.
  // Keep local APIs mocked until every server-side cleanup has completed.
  await vi.waitFor(() => expect(
    calls.filter((call) => call.path === '/profile/api/presence/update'),
  ).toHaveLength(clients.length));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ws-server principal private notification integration', () => {
  it('delivers approval decisions live to the existing agent socket without reconnect or catch-up (#2979)', async () => {
    const agent = await connect(AGENT);
    const socket = agent.ws;
    vi.stubEnv('AUTH_SERVICE_URL', `${origin}/auth`);
    vi.stubEnv('WS_PORT', String((server.address() as AddressInfo).port));
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      new URL(url).pathname === '/chat/api/internal/did-push'
        ? networkFetch(url, init)
        : localApi(url, init),
    ));

    await deliverToSubscribers({
      type: 'operator.approval.decided',
      issuer: PRINCIPAL,
      subject: AGENT,
      scope: 'operator',
      payload: { proposalId: 'skill_workshop_2979', status: 'approved' },
    });

    await vi.waitFor(() => expect(agent.frames).toContainEqual(expect.objectContaining({
      type: 'bus_event',
      eventType: 'operator.approval.decided',
      cursor: '2979',
      payload: { proposalId: 'skill_workshop_2979', status: 'approved' },
    })));
    expect(agent.ws).toBe(socket);
    expect(agent.ws.readyState).toBe(WebSocket.OPEN);
    expect(agent.frames.filter((frame) => frame.type === 'connected')).toHaveLength(1);
    expect(calls.some((call) => call.path.includes('catchup'))).toBe(false);
  });
  it('keeps ordinary notification fanout and reports an awaited boolean response', async () => {
    const principal = await connect(PRINCIPAL);
    const delegate = await connect(AGENT);
    await register(delegate);
    calls = [];
    const event = {
      type: 'notification', id: 'ntf_ordinary', scope: 'warp.run.completed',
      data: { eventType: 'warp.run.completed' },
    };
    expect(await (await push(event)).json()).toEqual({ delivered: true });
    await vi.waitFor(() => {
      expect(principal.frames).toContainEqual(event);
      expect(delegate.frames).toContainEqual(event);
    });
    expect(calls.some((call) => call.body.purpose === 'private-reach')).toBe(false);
  });
  it('preserves own requester bus delivery but denies stale delegates, authorizing the target not event subject', async () => {
    // Here the push target PRINCIPAL represents the already-entitled requester,
    // while subject is the unrelated replying principal.
    const requester = await connect(PRINCIPAL);
    const delegate = await connect(AGENT);
    await register(delegate);
    const event = {
      type: 'bus_event', id: 'bus_reply', eventType: 'agent.reach.replied',
      subject: 'did:imajin:replying-principal', issuer: 'did:imajin:replying-principal',
      payload: { message: 'Original reply', signature: { sig: 'public-test-signature' } },
    };
    expect(await (await push(event)).json()).toEqual({ delivered: true });
    await vi.waitFor(() => {
      expect(requester.frames).toContainEqual(event);
      expect(delegate.frames).toContainEqual(event);
    });
    allowed = false;
    const stale = { ...event, id: 'bus_reply_after_revocation' };
    expect(await (await push(stale)).json()).toEqual({ delivered: true });
    await vi.waitFor(() => expect(requester.frames).toContainEqual(stale));
    expect(delegate.frames).not.toContainEqual(stale);
    expect(calls.some((call) => call.body.principalDid === event.subject)).toBe(false);
    expect(calls).toContainEqual({
      path: '/auth/api/internal/verify-delegation',
      body: { agentDid: AGENT, principalDid: PRINCIPAL, purpose: 'private-reach' },
    });
  });
  it.each(['agent.reach.delivered', 'agent.reach.replied'])('fans out %s unchanged to principal and currently authorized delegate', async (scope) => {
    const principal = await connect(PRINCIPAL);
    const delegate = await connect(AGENT);
    const stranger = await connect('did:imajin:stranger');
    await register(delegate);
    const event = notification('ntf_live', scope);
    expect(await (await push(event)).json()).toEqual({ delivered: true });
    await vi.waitFor(() => {
      expect(principal.frames).toContainEqual(event);
      expect(delegate.frames).toContainEqual(event);
    });
    expect(stranger.frames).not.toContainEqual(event);
    expect(calls).toContainEqual({
      path: '/auth/api/internal/verify-delegation',
      body: { agentDid: AGENT, principalDid: PRINCIPAL, purpose: 'private-reach' },
    });
  });

  it('replays principal private notifications after register_also and binds plugin ACK without a did', async () => {
    const event = { ...notification('ntf_replay', 'agent.reach.replied'), replay: true };
    backlog = [event];
    const delegate = await connect(AGENT);
    await register(delegate);
    await vi.waitFor(() => expect(delegate.frames).toContainEqual(event));
    expect(calls).toContainEqual({
      path: '/notify/api/internal/backlog', body: { did: PRINCIPAL, privateReachOnly: true },
    });
    delegate.ws.send(JSON.stringify({ type: 'notification_ack', id: 'ntf_replay' }));
    await vi.waitFor(() => expect(calls).toContainEqual({
      path: '/notify/api/internal/ack', body: { id: 'ntf_replay', did: PRINCIPAL },
    }));
    delegate.ws.send(JSON.stringify({ type: 'notification_ack', id: 'unobserved', did: PRINCIPAL }));
    await vi.waitFor(() => expect(calls).toContainEqual({
      path: '/notify/api/internal/ack', body: { id: 'unobserved', did: AGENT },
    }));
  });

  it('denies replay, sends and ACK after authority is revoked even though coarse registration still succeeds', async () => {
    const delegate = await connect(AGENT);
    await register(delegate);
    expect(await (await push(notification('observed'))).json()).toEqual({ delivered: true });
    await vi.waitFor(() => expect(delegate.frames).toContainEqual(notification('observed')));
    allowed = false;
    calls = [];
    backlog = [notification('backlog_denied')];
    await register(delegate);
    expect(await (await push(notification('live_denied'))).json()).toEqual({ delivered: false });
    delegate.ws.send(JSON.stringify({ type: 'notification_ack', id: 'observed' }));
    await command(delegate, { type: 'ping' }, 'pong');
    expect(calls.some((call) => call.path.endsWith('/backlog'))).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/ack'))).toBe(false);
    expect(delegate.frames.some((frame) => frame.id === 'live_denied' || frame.id === 'backlog_denied')).toBe(false);
  });

  it('awaits private did-push authorization and cancels a send that races unregister', async () => {
    const delegate = await connect(AGENT);
    await register(delegate);
    let resolve!: (response: Response) => void;
    verifyPrivate = () => new Promise<Response>((done) => { resolve = done; });
    const before = calls.length;
    let completed = false;
    const pendingPush = push(notification('raced')).then((response) => { completed = true; return response; });
    await vi.waitFor(() => expect(calls.slice(before).some((call) => call.body.purpose === 'private-reach')).toBe(true));
    expect(completed).toBe(false);
    await command(delegate, { type: 'unregister_also', did: PRINCIPAL }, 'unregistered_also');
    resolve(Response.json({ allowed: true }));
    expect(await (await pendingPush).json()).toEqual({ delivered: false });
    expect(delegate.frames.some((frame) => frame.id === 'raced')).toBe(false);
  });

  it('fails closed on lookup failures and denies unauthorized internal push requests', async () => {
    const delegate = await connect(AGENT);
    await register(delegate);
    verifyPrivate = async () => Response.json({ error: 'Unavailable' }, { status: 500 });
    expect(await (await push(notification('failed'))).json()).toEqual({ delivered: false });
    expect((await push(notification('unauthorized'), 'wrong-public-fixture')).status).toBe(401);
    expect(delegate.frames.some((frame) => frame.id === 'failed' || frame.id === 'unauthorized')).toBe(false);
  });
});
