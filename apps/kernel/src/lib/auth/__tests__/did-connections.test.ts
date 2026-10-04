/**
 * #2407 — kernel client for ws-server's did-connections lookup.
 *
 * The contract that matters: "could not check" is `unknown`, never
 * `disconnected`, and nothing here ever throws into a route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({ logMock: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

vi.mock('@imajin/logger', () => ({ createLogger: () => logMock }));

import { getDidConnectionStates } from '../did-connections';

const JIN = 'did:imajin:jin';
const TRAVEL = 'did:imajin:jin-travel';
const KEY = 'internal-key-value';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  process.env.AUTH_INTERNAL_API_KEY = KEY;
  delete process.env.WS_PORT;
  process.env.PORT = '4000';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_INTERNAL_API_KEY;
  delete process.env.PORT;
});

describe('getDidConnectionStates', () => {
  it('returns an empty map without calling ws-server when there is nothing to look up', async () => {
    const states = await getDidConnectionStates([]);

    expect(states.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps connected / disconnected from the ws-server reply, authenticating with the internal key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: [JIN] }));

    const states = await getDidConnectionStates([JIN, TRAVEL]);

    expect(states.get(JIN)).toBe('connected');
    expect(states.get(TRAVEL)).toBe('disconnected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4000/chat/api/internal/did-connections');
    expect(init.method).toBe('POST');
    expect(init.headers['x-internal-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({ dids: [JIN, TRAVEL] });
  });

  it('prefers WS_PORT over PORT, like the did-push client', async () => {
    process.env.WS_PORT = '5000';
    fetchMock.mockResolvedValue(jsonResponse({ connected: [] }));

    await getDidConnectionStates([JIN]);

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5000/chat/api/internal/did-connections');
    delete process.env.WS_PORT;
  });

  it('deduplicates the requested DIDs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: [JIN] }));

    const states = await getDidConnectionStates([JIN, JIN]);

    expect(states.size).toBe(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ dids: [JIN] });
  });

  it("is 'unknown' for every DID when AUTH_INTERNAL_API_KEY is unset, without calling ws-server", async () => {
    delete process.env.AUTH_INTERNAL_API_KEY;

    const states = await getDidConnectionStates([JIN, TRAVEL]);

    expect([...states.values()]).toEqual(['unknown', 'unknown']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is 'unknown' (not 'disconnected') on a non-2xx reply", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    const states = await getDidConnectionStates([JIN]);

    expect(states.get(JIN)).toBe('unknown');
  });

  it("is 'unknown' when ws-server is unreachable — never throws", async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const states = await getDidConnectionStates([JIN]);

    expect(states.get(JIN)).toBe('unknown');
  });

  it("is 'unknown' when the reply is malformed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: 'yes' }));

    const states = await getDidConnectionStates([JIN]);

    expect(states.get(JIN)).toBe('unknown');
  });

  it('ignores non-string entries in a reply instead of trusting them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ connected: [JIN, 42, null] }));

    const states = await getDidConnectionStates([JIN, TRAVEL]);

    expect(states.get(JIN)).toBe('connected');
    expect(states.get(TRAVEL)).toBe('disconnected');
  });

  it('splits a large lookup into batches within the ws-server cap', async () => {
    const dids = Array.from({ length: 120 }, (_, i) => `did:imajin:agent-${i}`);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
      jsonResponse({ connected: (JSON.parse(init.body) as { dids: string[] }).dids.slice(0, 1) }),
    );

    const states = await getDidConnectionStates(dids);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((call) => (JSON.parse(call[1].body) as { dids: string[] }).dids.length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(states.size).toBe(120);
    expect(states.get(dids[0])).toBe('connected');
    expect(states.get(dids[1])).toBe('disconnected');
  });
});
