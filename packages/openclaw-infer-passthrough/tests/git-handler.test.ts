import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProxyServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/logger.js', () => ({ createLogger: () => logger }));
const realFetch = globalThis.fetch;
function credential(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = encode({
    sub: 'did:imajin:owner', azp: 'did:imajin:agent', exp: Date.now() / 1000 + 600, scope: 'github:read',
  });
  const unsigned = `${encode({ alg: 'EdDSA', typ: 'app+jwt' })}.${claims}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), generateKeyPairSync('ed25519').privateKey).toString('base64url')}`;
}
const advertisement = 'application/x-git-upload-pack-advertisement';
const prefix = '/github/git/ima-jin/private.git/';
let server: ReturnType<typeof createProxyServer>;
let base: string;
let upstream: ReturnType<typeof vi.fn>;
let token: string;
beforeEach(async () => {
  vi.clearAllMocks();
  token = credential();
  server = createProxyServer(loadConfig({ KERNEL_BASE_URL: 'https://kernel.test' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  upstream = vi.fn().mockImplementation(async () => new Response('0000', { headers: { 'Content-Type': advertisement } }));
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.startsWith(base) ? realFetch(url, init) : upstream(url, init)));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
function get(suffix = 'info/refs?service=git-upload-pack', headers: Record<string, string> = { Authorization: `Bearer ${token}` }) {
  return fetch(`${base}${prefix}${suffix}`, { headers });
}

describe('local git passthrough', () => {
  it('forwards only to the kernel with the calling credential and explicit owner selector', async () => {
    expect((await get(undefined, { Authorization: `Bearer ${token}`, 'X-Acting-For': 'did:imajin:org', 'Git-Protocol': 'version=2' })).status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://kernel.test/github/git/ima-jin/private.git/info/refs?service=git-upload-pack');
    expect(init.redirect).toBe('manual');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-acting-for')).toBe('did:imajin:org');
    expect(headers.get('git-protocol')).toBe('version=2');
    expect(headers.has('cookie')).toBe(false);
  });
  it('streams binary request and response bytes without converting through text or leaking headers', async () => {
    const bytes = randomBytes(64 * 1024);
    upstream.mockImplementation(async (_url, init) => {
      expect(Buffer.from(await new Response(init.body).arrayBuffer())).toEqual(bytes);
      return new Response(bytes, { headers: {
        'Content-Type': 'application/x-git-upload-pack-result',
        'WWW-Authenticate': 'upstream', 'Set-Cookie': 'upstream', Location: 'https://elsewhere.test',
      } });
    });
    const response = await fetch(`${base}${prefix}git-upload-pack`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-upload-pack-request' }, body: bytes,
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    for (const header of ['www-authenticate', 'set-cookie', 'location']) expect(response.headers.has(header)).toBe(false);
  });
  it.each(['git-receive-pack', 'info/refs?service=git-receive-pack'])('rejects push at %s without contacting kernel', async suffix => {
    expect((await get(suffix)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([{}, { Authorization: 'Bearer invalid' }, { 'x-api-key': 'invalid' }])('refuses absent or invalid agent credentials %#', async headers => {
    expect((await get(undefined, headers)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 500, 302])('preserves denials and discards response bodies, never retrying status %s', async status => {
    upstream.mockResolvedValue(new Response(token, { status, headers: { Location: `https://elsewhere.test/${token}` } }));
    const response = await get();
    expect(response.status).toBe([400, 401, 403, 404, 409].includes(status) ? status : 502);
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify([...response.headers])).not.toContain(token);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('does not log or return credential-bearing network errors', async () => {
    upstream.mockRejectedValue(new Error(token));
    const response = await get();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(token);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('rejects unsupported methods without forwarding', async () => {
    const response = await fetch(`${base}${prefix}git-upload-pack`, { method: 'DELETE' });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('does not forward a success response with an unexpected content type', async () => {
    upstream.mockResolvedValue(new Response(token, { headers: { 'Content-Type': 'text/html' } }));
    const response = await get();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(token);
  });
});
