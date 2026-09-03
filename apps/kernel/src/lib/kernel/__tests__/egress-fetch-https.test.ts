/**
 * Confirms `egressSafeFetch` dispatches through `https.request` (not
 * `http.request`) for an `https:` URL, and defaults to port 443 when the
 * URL carries none. Isolated in its own file because it mocks
 * `node:http`/`node:https` at the module level, which the main
 * `egress-fetch.test.ts` suite (real servers, real sockets) must not share.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

interface FakeRequest extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
}

function makeFakeRequest(): FakeRequest {
  const req = new EventEmitter() as FakeRequest;
  req.end = vi.fn();
  return req;
}

const httpRequestMock = vi.fn();
const httpsRequestMock = vi.fn();

vi.mock('node:http', () => ({ request: (...args: unknown[]) => httpRequestMock(...args) }));
vi.mock('node:https', () => ({ request: (...args: unknown[]) => httpsRequestMock(...args) }));

const { egressSafeFetch } = await import('../egress-fetch');

describe('egressSafeFetch scheme dispatch', () => {
  it('uses https.request and port 443 by default for an https: URL, never http.request', () => {
    const fakeReq = makeFakeRequest();
    httpsRequestMock.mockReturnValue(fakeReq);

    void egressSafeFetch('https://ollama.example/v1/models', { method: 'GET' }, { connector: 'local', timeoutMs: 5000, pinnedIp: '10.0.0.5' });

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).not.toHaveBeenCalled();
    const [options] = httpsRequestMock.mock.calls[0] as [{ port: number; hostname: string }];
    expect(options.port).toBe(443);
    expect(options.hostname).toBe('ollama.example');
  });

  it('uses http.request and port 80 by default for an http: URL', () => {
    httpRequestMock.mockReset();
    httpsRequestMock.mockReset();
    const fakeReq = makeFakeRequest();
    httpRequestMock.mockReturnValue(fakeReq);

    void egressSafeFetch('http://ollama.example/v1/models', { method: 'GET' }, { connector: 'local', timeoutMs: 5000, pinnedIp: '10.0.0.5' });

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).not.toHaveBeenCalled();
    const [options] = httpRequestMock.mock.calls[0] as [{ port: number }];
    expect(options.port).toBe(80);
  });
});
