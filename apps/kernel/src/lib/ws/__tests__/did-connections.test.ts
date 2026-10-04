/**
 * #2407 — the pure half of ws-server's did-connections route.
 *
 * What must hold: only OPEN own sockets count, the route is closed to anyone
 * without the internal key (including when the server's key is unset), and a
 * lookup is read-only.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ws-server.js and everything it loads is plain CJS, outside the Next build.
const {
  parseDidConnectionsBody,
  connectedDids,
  handleDidConnectionsRequest,
  DID_CONNECTIONS_PATH,
  MAX_DIDS_PER_LOOKUP,
  MAX_BODY_BYTES,
} = require('../did-connections');

const JIN = 'did:imajin:jin';
const TRAVEL = 'did:imajin:jin-travel';
const KEY = 'internal-key-value';

type Socket = { readyState: number };

function sockets(...states: number[]): Set<Socket> {
  return new Set(states.map((readyState) => ({ readyState })));
}

describe('parseDidConnectionsBody', () => {
  it('accepts a non-empty list of DID strings and deduplicates it', () => {
    expect(parseDidConnectionsBody({ dids: [JIN, TRAVEL, JIN] })).toEqual({ ok: true, dids: [JIN, TRAVEL] });
  });

  it.each([
    ['null', null],
    ['a string', 'did:imajin:jin'],
    ['no dids key', {}],
    ['dids not an array', { dids: JIN }],
    ['an empty list', { dids: [] }],
    ['a non-string entry', { dids: [JIN, 7] }],
    ['an empty-string entry', { dids: [JIN, ''] }],
    ['more than the cap', { dids: Array.from({ length: MAX_DIDS_PER_LOOKUP + 1 }, (_, i) => `did:imajin:${i}`) }],
  ])('rejects %s', (_label, body) => {
    expect(parseDidConnectionsBody(body)).toEqual({ ok: false });
  });
});

describe('connectedDids', () => {
  it('reports a DID connected only when it holds at least one OPEN own socket', () => {
    const didSockets = new Map([
      [JIN, sockets(3, 1)], // one closed, one open
      [TRAVEL, sockets(3, 2)], // closed / closing only
    ]);

    expect(connectedDids(didSockets, [JIN, TRAVEL, 'did:imajin:unseen'])).toEqual([JIN]);
  });

  it('treats an empty socket set and an absent DID as disconnected', () => {
    expect(connectedDids(new Map([[JIN, sockets()]]), [JIN, TRAVEL])).toEqual([]);
  });
});

interface FakeRes {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

function fakeReq(headers: Record<string, string>) {
  return Object.assign(new EventEmitter(), { headers });
}

function dispatch(opts: { headers?: Record<string, string>; chunks?: string[]; serverKey?: string | undefined; didSockets?: Map<string, Set<Socket>> }) {
  const req = fakeReq(opts.headers ?? {});
  const res = fakeRes();
  handleDidConnectionsRequest(req, res, opts.didSockets ?? new Map(), 'serverKey' in opts ? opts.serverKey : KEY);
  for (const chunk of opts.chunks ?? []) req.emit('data', chunk);
  req.emit('end');
  return res;
}

describe('handleDidConnectionsRequest', () => {
  it('exposes the internal path the kernel client posts to', () => {
    expect(DID_CONNECTIONS_PATH).toBe('/chat/api/internal/did-connections');
  });

  it('answers 200 with the connected subset for a valid, authenticated lookup', () => {
    const res = dispatch({
      headers: { 'x-internal-key': KEY },
      chunks: [JSON.stringify({ dids: [JIN, TRAVEL] })],
      didSockets: new Map([[JIN, sockets(1)]]),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ connected: [JIN] });
  });

  it('reassembles a body delivered in several chunks', () => {
    const payload = JSON.stringify({ dids: [JIN] });
    const res = dispatch({
      headers: { 'x-internal-key': KEY },
      chunks: [payload.slice(0, 5), payload.slice(5)],
      didSockets: new Map([[JIN, sockets(1)]]),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ connected: [JIN] });
  });

  it('refuses a request with no key', () => {
    expect(dispatch({ chunks: [JSON.stringify({ dids: [JIN] })] }).status).toBe(401);
  });

  it('refuses a request with the wrong key', () => {
    expect(dispatch({ headers: { 'x-internal-key': 'nope' }, chunks: [JSON.stringify({ dids: [JIN] })] }).status).toBe(401);
  });

  it('refuses everything when the server key is unset — an absent header must not match undefined', () => {
    const res = dispatch({ serverKey: undefined, chunks: [JSON.stringify({ dids: [JIN] })] });

    expect(res.status).toBe(401);
    expect(res.body).not.toContain(JIN);
  });

  it('refuses before reading or answering anything for an unauthorized caller', () => {
    const req = fakeReq({});
    const res = fakeRes();

    handleDidConnectionsRequest(req, res, new Map([[JIN, sockets(1)]]), KEY);

    expect(res.status).toBe(401);
    expect(req.listenerCount('data')).toBe(0);
  });

  it('answers 400 for malformed JSON and for an invalid DID list', () => {
    expect(dispatch({ headers: { 'x-internal-key': KEY }, chunks: ['{not json'] }).status).toBe(400);
    expect(dispatch({ headers: { 'x-internal-key': KEY }, chunks: [JSON.stringify({ dids: [] })] }).status).toBe(400);
  });

  it('answers 413 for an oversized body', () => {
    const res = dispatch({ headers: { 'x-internal-key': KEY }, chunks: ['x'.repeat(MAX_BODY_BYTES + 1), 'more'] });

    expect(res.status).toBe(413);
  });
});

describe('setupDidConnectionsRoute (ws-server.js wiring)', () => {
  // The whole ws-server module, not just the helper: this is the seam Next hits.
  const { setupDidConnectionsRoute } = require('../../../../ws-server');

  function fakeServer() {
    const server = new EventEmitter();
    const original = vi.fn();
    server.on('request', original);
    setupDidConnectionsRoute(server);
    return { server, original };
  }

  it('handles POST to the did-connections path itself and does not forward it to Next', () => {
    const { server, original } = fakeServer();
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: DID_CONNECTIONS_PATH, headers: {} });
    const res = fakeRes();

    server.emit('request', req, res);

    // No x-internal-key: refused by the handler, never reaching the original listener.
    expect(res.status).toBe(401);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ['a GET to the same path', 'GET', DID_CONNECTIONS_PATH],
    ['a POST to another path', 'POST', '/chat/api/internal/did-push'],
  ])('passes %s through to the original request listeners untouched', (_label, method, url) => {
    const { server, original } = fakeServer();
    const req = Object.assign(new EventEmitter(), { method, url, headers: {} });
    const res = fakeRes();

    server.emit('request', req, res);

    expect(original).toHaveBeenCalledTimes(1);
    expect(res.status).toBeUndefined();
  });
});
