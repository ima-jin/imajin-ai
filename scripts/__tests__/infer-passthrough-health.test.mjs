import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { checkHealth } from '../../deploy/infer-passthrough/check-health.mjs';

const checker = resolve(import.meta.dirname, '../../deploy/infer-passthrough/check-health.mjs');
let server;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
});

function run(port, attempts = '1') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, String(port)], {
      env: { ...process.env, INFER_HEALTH_ATTEMPTS: attempts },
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('release mint-health check', () => {
  it.each([
    [200, { ok: true, routes: [{ ok: true }] }, 0],
    [503, { ok: false, routes: [{ ok: false }] }, 1],
    [200, { kernelOk: true }, 1],
    [200, { ok: true, routes: [] }, 1],
    [200, { ok: true, routes: [null] }, 1],
    [200, null, 1],
  ])('validates the actual checker implementation (%s, %j)', async (status, body, result) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    expect(await checkHealth('8787', 1)).toBe(result);
  });

  it('retries startup/network failures but never prints their detail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('untrusted upstream detail'))
      .mockResolvedValueOnce(Response.json({ ok: true, routes: [{ ok: true }] })));
    expect(await checkHealth('8787', 2)).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([['0', 1], ['65536', 1], ['8787', 0], ['8787', 31]])('fails validation before fetching (%s, %s)', async (port, attempts) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkHealth(port, attempts)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [200, { ok: true, routes: [{ route: 'openai', ok: true }] }, 0],
    [503, { ok: false, routes: [{ route: 'openai', ok: false }] }, 1],
    [200, { kernelOk: true }, 1],
    [200, { ok: true, routes: [] }, 1],
    [200, { ok: true, routes: [{ ok: false }] }, 1],
    [503, { ok: true, routes: [{ ok: true }] }, 1],
    [200, 'non-json', 1],
  ])('requires HTTP success and every route mint (%s, %j)', async (status, body, code) => {
    server = createServer((req, res) => {
      expect(req.url).toBe('/health');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const result = await run(server.address().port);
    expect(result.code).toBe(code);
    if (code) expect(result.stderr).toContain('/jin → Grants');
  });

  it.each([['0', '1'], ['65536', '1'], ['bad', '1'], ['8787', '0'], ['8787', '31'], ['8787', '1.5']])(
    'rejects invalid port/attempt arguments (%s, %s)', async (port, attempts) => {
      expect((await run(port, attempts)).code).toBe(2);
    },
  );
});
