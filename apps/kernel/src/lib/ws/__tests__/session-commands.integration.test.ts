import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { WebSocket as Socket } from 'ws';
const { WebSocket } = require('ws');
const { setupWebSocket, setupBroadcastRoute } = require('../../../../ws-server');
const networkFetch = globalThis.fetch;
const agent = 'did:imajin:agent';
const principal = 'did:imajin:principal';
const internalKey = 'inert-session-integration-fixture';
type Client = { ws: Socket; did: string; frames: Record<string, unknown>[] };
let clients: Client[];
let calls: { path: string; body: Record<string, unknown> }[];
let server: Server;
let origin: string;
let timer: ReturnType<typeof setInterval>;

async function localApi(url: string, init?: RequestInit): Promise<Response> {
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ path, body });
  if (path.endsWith('/session')) {
    const cookie = (init?.headers as Record<string, string>).Cookie;
    return Response.json({ did: cookie.split('=').slice(1).join('=') });
  }
  if (path.endsWith('/verify-delegation')) return Response.json({ allowed: true });
  if (path.endsWith('/backlog')) return Response.json({ frames: [], truncated: false });
  return Response.json({ accepted: true });
}
async function connect(did: string): Promise<Client> {
  const ws: Socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: `imajin_session=${did}` } });
  const client = { ws, did, frames: [] as Record<string, unknown>[] };
  ws.on('message', bytes => client.frames.push(JSON.parse(bytes.toString())));
  clients.push(client);
  await vi.waitFor(() => expect(client.frames.some(frame => frame.type === 'connected')).toBe(true));
  return client;
}
async function registerAlso(client: Client, did: string) {
  client.ws.send(JSON.stringify({ type: 'register_also', did }));
  await vi.waitFor(() => expect(client.frames.some(frame => frame.type === 'registered_also')).toBe(true));
}
async function push(command: Record<string, unknown>, key = internalKey) {
  return networkFetch(`${origin}/chat/api/internal/session-command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
    body: JSON.stringify({ targetDid: agent, command }),
  });
}
beforeEach(async () => {
  clients = []; calls = [];
  vi.stubEnv('AUTH_INTERNAL_API_KEY', internalKey); vi.stubEnv('IMAJIN_ENV', 'prod');
  vi.stubGlobal('fetch', vi.fn(localApi));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
    timer = interval(...args); return timer;
  });
  server = createServer(); setupBroadcastRoute(server); setupWebSocket(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  clearInterval(timer);
  for (const { ws } of clients) {
    if (ws.readyState === 3) continue;
    const closed = once(ws, 'close'); ws.terminate(); await closed;
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
  await vi.waitFor(() => expect(calls.filter(call => call.path === '/profile/api/presence/update')).toHaveLength(new Set(clients.map(client => client.did)).size));
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
describe('real ws-server session command rail', () => {
  it('sends full command to only one own agent connection, never principal or register_also delegate', async () => {
    const own = await connect(agent); const duplicate = await connect(agent);
    const owner = await connect(principal); const delegate = await connect('did:imajin:delegate');
    await registerAlso(delegate, agent);
    const frame = { type: 'session.send', to: agent, payload: { loopId: 'loop', message: 'private original command' } };
    expect(await (await push(frame)).json()).toEqual({ delivered: true });
    await vi.waitFor(() => expect(own.frames).toContainEqual(frame));
    for (const client of [duplicate, owner, delegate]) expect(client.frames).not.toContainEqual(frame);
  });
  it('forwards signed result and binding using own authenticated DID even when delegated for principal', async () => {
    const own = await connect(agent); await registerAlso(own, principal);
    calls = [];
    const outcome = { type: 'loop.session.send.completed', attestation: { from: agent, payload: { commandId: 'cmd' } } };
    const binding = { type: 'loop.approval.bound', attestation: { from: agent, payload: { principalDid: principal } } };
    own.ws.send(JSON.stringify(outcome)); own.ws.send(JSON.stringify(binding));
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/jin/api/internal/session-events')).toHaveLength(2));
    expect(calls).toContainEqual({ path: '/jin/api/internal/session-events', body: { socketDid: agent, frame: outcome } });
    expect(calls).toContainEqual({ path: '/jin/api/internal/session-events', body: { socketDid: agent, frame: binding } });
  });
  it('requires internal key and reports offline honestly with no delegate fallback', async () => {
    const delegate = await connect('did:imajin:delegate'); await registerAlso(delegate, agent);
    const frame = { type: 'session.abort', to: agent, payload: { loopId: 'loop' } };
    expect((await push(frame, 'wrong')).status).toBe(401);
    expect(await (await push(frame)).json()).toEqual({ delivered: false });
    expect(delegate.frames).not.toContainEqual(frame);
  });
});
