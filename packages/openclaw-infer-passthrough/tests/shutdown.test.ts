import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown, shutdownGraceMs } from '../src/shutdown.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(handler: RequestListener, graceMs = 500) {
  const server = createServer(handler);
  const exit = vi.fn();
  const control = installGracefulShutdown(server, { graceMs, exit });
  cleanups.push(() => {
    control.dispose();
    server.close();
    server.closeAllConnections();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, exit, ...control, url: `http://127.0.0.1:${port}`, port };
}

describe('shutdown grace validation', () => {
  it.each(['', ' ', '0', '-1', 'NaN', 'Infinity', '1.5', '20ms', '9007199254740992'])(
    'uses the safe default for invalid value %j', raw => {
      expect(shutdownGraceMs(raw)).toBe(5000);
    },
  );
  it.each([['1', 1], ['5000', 5000], ['8000', 8000], ['9000', 8000]])(
    'bounds %s to %i ms', (raw, expected) => {
      expect(shutdownGraceMs(raw)).toBe(expected);
    },
  );
  it('reads the environment and defaults when unset', () => {
    vi.stubEnv('INFER_PROXY_SHUTDOWN_GRACE_MS', undefined);
    expect(shutdownGraceMs()).toBe(5000);
    vi.stubEnv('INFER_PROXY_SHUTDOWN_GRACE_MS', '6000');
    expect(shutdownGraceMs()).toBe(6000);
  });
});

describe('graceful HTTP drain', () => {
  it('finishes an in-flight streaming response before exit 0, within grace', async () => {
    let response!: ServerResponse;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await fixture((_req, res) => {
      response = res;
      res.writeHead(200);
      res.write('first');
    });
    const result = await fetch(f.url);
    const text = result.text();
    const started = performance.now();
    f.shutdown();
    expect(f.server.listening).toBe(false);
    expect(f.exit).not.toHaveBeenCalled();
    response.end('last');
    expect(await text).toBe('firstlast');
    expect(result.status).toBe(200);
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledTimes(1));
    expect(f.exit).toHaveBeenCalledWith(0);
    expect(performance.now() - started).toBeLessThan(500);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      inFlightAtSignal: 1, cutAtGrace: false,
    }));
  });

  it('closes idle keep-alive connections and exits in under one second', async () => {
    const f = await fixture((_req, res) => res.end('ok'));
    await (await fetch(f.url)).text();
    const started = performance.now();
    f.shutdown();
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledTimes(1));
    expect(f.exit).toHaveBeenCalledWith(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('cuts a hung response at the bounded grace and exits only once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await fixture((_req, res) => {
      res.writeHead(200);
      res.write('held');
    }, 80);
    const response = await fetch(f.url);
    const text = response.text().catch(() => 'connection cut');
    const started = performance.now();
    f.shutdown();
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledTimes(1));
    expect(f.exit).toHaveBeenCalledWith(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(70);
    expect(performance.now() - started).toBeLessThan(500);
    expect(await text).toBe('connection cut');
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      inFlightAtSignal: 1, cutAtGrace: true,
    }));
  });

  it('rejects a pipelined request on an existing socket with 503 and Connection: close', async () => {
    let first!: ServerResponse;
    const handler = vi.fn((_req, res: ServerResponse) => {
      first = res;
      res.writeHead(200, { 'Content-Length': '2' });
      res.write('o');
    });
    const f = await fixture(handler);
    const socket = connect(f.port, '127.0.0.1');
    cleanups.push(() => socket.destroy());
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.write('GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await vi.waitFor(() => expect(data).toContain('200 OK'));
    f.shutdown();
    const secondReceived = new Promise<void>(resolve => {
      f.server.on('request', req => {
        if (req.url === '/second') resolve();
      });
    });
    socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await secondReceived;
    first.end('k');
    await vi.waitFor(() => expect(data).toContain('503 Service Unavailable'));
    expect(data.toLowerCase()).toContain('connection: close');
    expect(data).toContain('shutting_down');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exits immediately on a second signal and removes its signal listeners', async () => {
    const before = process.listenerCount('SIGTERM');
    const f = await fixture((_req, res) => res.write('held'), 5000);
    const response = await fetch(f.url);
    const text = response.text().catch(() => 'cut');
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    f.shutdown();
    f.shutdown();
    expect(f.exit).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(0);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(await text).toBe('cut');
  });

  it('drains a disconnected client without waiting for grace', async () => {
    const f = await fixture((_req, res) => res.write('held'));
    const controller = new AbortController();
    const response = await fetch(f.url, { signal: controller.signal });
    const text = response.text().catch(() => 'disconnected');
    f.shutdown();
    controller.abort();
    await text;
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledTimes(1));
    expect(f.exit).toHaveBeenCalledWith(0);
  });
});
