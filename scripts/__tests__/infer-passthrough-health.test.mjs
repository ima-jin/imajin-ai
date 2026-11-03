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

function run(port, attempts = '1', authMode = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, String(port), authMode], {
      env: { ...process.env, INFER_HEALTH_ATTEMPTS: attempts },
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('release mint-health check', () => {
  const agentBody = { ok: true, authMode: 'agent', credentialRequired: true };
  const hostBody = { ok: true, routes: [{ ok: true }] };

  it.each([
    [undefined, 200, agentBody, 1], ['', 200, agentBody, 1],
    ['host-static', 200, agentBody, 1],
    ['agent', 200, agentBody, 0], ['agent', 503, agentBody, 1],
    ['agent', 200, hostBody, 1],
    ['agent', 200, { ...hostBody, credentialRequired: true }, 1],
    ['agent', 200, { ...agentBody, authMode: 'host-static' }, 1],
    ['agent', 200, { ...agentBody, credentialRequired: false }, 1],
    ['agent', 200, { ok: true, authMode: 'agent' }, 1],
    ['agent', 200, { ...agentBody, credentialRequired: 'true' }, 1],
    ['agent', 200, { ...agentBody, ok: false }, 1],
    ['agent', 200, { ...agentBody, ok: 'true' }, 1],
    ['agent', 200, { authMode: 'agent', credentialRequired: true }, 1],
    ['agent', 200, null, 1],
    ['host-static', 200, hostBody, 0],
    ['host-static', 503, hostBody, 1],
    ['host-static', 200, { ...hostBody, ok: false }, 1],
    ['host-static', 200, { ok: true, routes: [] }, 1],
    ['host-static', 200, { ok: true, routes: [{ ok: true }, { ok: false }] }, 1],
    ['', 200, { ok: true, routes: [{ ok: true }, { ok: false }] }, 1],
  ])('requires the declared mode health contract (%s, %s, %j)', async (mode, status, body, result) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    expect(await checkHealth('8787', 1, mode)).toBe(result);
    if (result) expect(error).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown-mode', ' agent', 'AGENT', '"agent"'])('refuses an invalid declaration without disclosure or a fetch', async (mode) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkHealth('8787', 1, mode)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Invalid declared health authentication mode');
  });

  it.each(['', 'host-static', 'agent'])('never follows redirects away from the fixed health endpoint (%s)', async (mode) => {
    const paths = [];
    server = createServer((req, res) => {
      paths.push(req.url);
      if (req.url === '/health') {
        res.writeHead(302, { Location: '/redirect-target' });
        res.end();
      } else {
        res.end(JSON.stringify({ ok: true, routes: [{ ok: true }] }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect((await run(server.address().port, '1', mode)).code).toBe(1);
    expect(paths).toEqual(['/health']);
  });
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

  it.each(['', 'host-static', 'agent'])('retries startup/network failures but never prints their detail (%s)', async (mode) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('untrusted upstream detail'))
      .mockResolvedValueOnce(Response.json(mode === 'agent' ? agentBody : hostBody)));
    expect(await checkHealth('8787', 2, mode)).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
  it.each(['', 'host-static', 'agent'])('suppresses exhausted network and response details (%s)', async (mode) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('untrusted upstream detail')));
    expect(await checkHealth('8787', 1, mode)).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).not.toContain('untrusted upstream detail');
  });

  it.each([
    ['', agentBody, 1], ['host-static', agentBody, 1],
    ['agent', agentBody, 0], ['agent', hostBody, 1],
    ['agent', { ...agentBody, credentialRequired: false }, 1],
  ])('passes explicit mode through the CLI against fake health (%s, %j)', async (mode, body, code) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect((await run(server.address().port, '1', mode)).code).toBe(code);
  });

  it('uses a fixed CLI diagnostic for an invalid declared mode', async () => {
    expect(await run('8787', '1', 'unknown-mode')).toEqual({
      code: 2, stderr: 'Invalid declared health authentication mode\n',
    });
  });

  it.each([['0', 1], ['65536', 1], ['8787', 0], ['8787', 31],
    ['8787@other.test', 1], ['8787/other', 1], ['http://other.test', 1],
  ])('fails validation before fetching (%s, %s)', async (port, attempts) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkHealth(port, attempts)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [200, { ok: true, routes: [{ route: 'openai', ok: true }] }, 0],
    [200, { ok: true, routes: [{ route: 'openai', ok: true }, { route: 'mcp', ok: true, skipped: true }] }, 0],
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
    if (code) {
      expect(result.stderr).toContain('inspect route readiness for the cause and remedy');
      expect(result.stderr).not.toContain('re-grant');
    }
  });

  it.each([['0', '1'], ['65536', '1'], ['bad', '1'], ['8787', '0'], ['8787', '31'], ['8787', '1.5']])(
    'rejects invalid port/attempt arguments (%s, %s)', async (port, attempts) => {
      expect((await run(port, attempts)).code).toBe(2);
    },
  );
});
