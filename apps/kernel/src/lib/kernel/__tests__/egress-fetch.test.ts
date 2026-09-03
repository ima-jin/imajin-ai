import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { egressSafeFetch } from '../egress-fetch';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '@/src/lib/inference/completions/errors';

let server: Server | undefined;

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('egressSafeFetch', () => {
  it('connects to the pinned IP and returns status/body/headers', async () => {
    const port = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'yes' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });

    const res = await egressSafeFetch(
      `http://ollama.example:${port}/v1/models`,
      { method: 'GET' },
      { connector: 'local', timeoutMs: 5000, pinnedIp: '127.0.0.1' },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('yes');
    const body = await res.json() as { ok: boolean; path: string };
    expect(body).toEqual({ ok: true, path: '/v1/models' });
  });

  it('forwards a POST body and headers', async () => {
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') }));
      });
    });

    const res = await egressSafeFetch(
      `http://vllm.example:${port}/v1/chat/completions`,
      { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{"a":1}' },
      { connector: 'local', timeoutMs: 5000, pinnedIp: '127.0.0.1' },
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { auth: string; body: string };
    expect(body).toEqual({ auth: 'Bearer tok', body: '{"a":1}' });
  });

  it('passes through a non-2xx status without following it as a redirect', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://evil.example/' });
      res.end('moved');
    });

    const res = await egressSafeFetch(
      `http://redirecting.example:${port}/`,
      { method: 'GET' },
      { connector: 'local', timeoutMs: 5000, pinnedIp: '127.0.0.1' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://evil.example/');
  });

  it('streams a response body without buffering it whole', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 10);
    });

    const res = await egressSafeFetch(
      `http://streaming.example:${port}/`,
      { method: 'GET' },
      { connector: 'local', timeoutMs: 5000, pinnedIp: '127.0.0.1' },
    );

    const text = await res.text();
    expect(text).toContain('data: one');
    expect(text).toContain('data: two');
  });

  it('throws UpstreamTimeoutError when the upstream never responds in time', async () => {
    const port = await listen((_req, _res) => {
      // Never respond.
    });

    await expect(
      egressSafeFetch(
        `http://slow.example:${port}/`,
        { method: 'GET' },
        { connector: 'local', timeoutMs: 30, pinnedIp: '127.0.0.1' },
      ),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it('throws UpstreamUnavailableError when the connection is refused', async () => {
    // Nothing is listening on this port.
    await expect(
      egressSafeFetch(
        'http://unreachable.example:1/',
        { method: 'GET' },
        { connector: 'local', timeoutMs: 2000, pinnedIp: '127.0.0.1' },
      ),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});
