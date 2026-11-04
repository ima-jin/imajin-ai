import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverPath = 'packages/openclaw-infer-passthrough/src/server.ts';

// These are real POSIX process-group signals, not Windows' forceful kill emulation.
// Shutdown regressions must assert drain/exit events, not minimum elapsed time (#3270).
// Each case owns the shared process group until cleanup, even with --sequence.concurrent.
describe.skipIf(process.platform !== 'linux').sequential('standalone node --import tsx process-group shutdown', () => {
  const graceMs = 1000;
  const exitBoundMs = graceMs + 5000;
  const testTimeoutMs = exitBoundMs + 5000;
  let child: ChildProcess;
  let upstream: Server;
  let upstreamResponse: ServerResponse;
  let output: string;
  let directory: string;
  let baseUrl: string;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  async function listen(server: Server) {
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    return (server.address() as AddressInfo).port;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'infer-shutdown-'));
    // CI tests run before builds. Resolve the real workspace sources, not mocks.
    const tsconfig = join(directory, 'tsconfig.json');
    await writeFile(tsconfig, JSON.stringify({
      compilerOptions: {
        paths: {
          '@imajin/auth/*': [resolve('packages/auth/src/*.ts')],
          '@imajin/*': [resolve('packages/*/src/index.ts')],
        },
      },
    }));
    upstream = createServer((_req, res) => {
      upstreamResponse = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
    });
    const upstreamPort = await listen(upstream);
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>(done => reservation.close(() => done()));
    baseUrl = `http://127.0.0.1:${port}`;
    output = '';
    child = spawn(process.execPath, [
      '--import', 'tsx', resolve(serverPath),
    ], {
      detached: true,
      env: {
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: tsconfig,
        KERNEL_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        INFER_PROXY_AUTH_MODE: 'agent', INFER_PROXY_PORT: String(port),
        INFER_PROXY_SHUTDOWN_GRACE_MS: String(graceMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((resolveExit, reject) => {
      child.once('error', reject);
      // close follows exit AND stdout/stderr EOF, so final drain logs are available.
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { output += data.toString(); });
    await vi.waitFor(() => {
      expect(child.exitCode, output).toBeNull();
      expect(output).toContain('openclaw-infer-passthrough listening');
    }, { timeout: 10_000 });
  }, 15_000);

  afterEach(async () => {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      await exited;
    }
    upstream?.closeAllConnections();
    await new Promise<void>(done => upstream ? upstream.close(() => done()) : done());
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function shutdownEvents() {
    return output.split('\n').slice(0, -1)
      .filter(line => line.includes('"msg":"openclaw-infer-passthrough draining"')
        || line.includes('"msg":"openclaw-infer-passthrough shutdown complete"'))
      .map(line => JSON.parse(line));
  }

  async function assertDraining(inFlightAtSignal: number) {
    await vi.waitFor(() => expect(shutdownEvents(), output).toContainEqual(expect.objectContaining({
      msg: 'openclaw-infer-passthrough draining', inFlightAtSignal,
    })), { timeout: exitBoundMs });
  }

  async function assertExited(inFlightAtSignal: number, cutAtGrace: boolean) {
    const deadline = new AbortController();
    try {
      expect(await Promise.race([
        exited, delay(exitBoundMs, 'shutdown timed out', { signal: deadline.signal }),
      ]), output).toEqual({ code: 0, signal: null });
    } finally {
      deadline.abort();
    }
    expect(shutdownEvents(), output).toEqual([
      expect.objectContaining({ msg: 'openclaw-infer-passthrough draining', inFlightAtSignal }),
      expect.objectContaining({
        msg: 'openclaw-infer-passthrough shutdown complete', inFlightAtSignal, cutAtGrace,
      }),
    ]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  }

  function signal(name: NodeJS.Signals = 'SIGTERM') {
    process.kill(-child.pid!, name);
  }

  async function stream() {
    const { privateKey } = generateKeyPairSync('ed25519');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'EdDSA', typ: 'app+jwt' })}.${encode({
      azp: 'did:imajin:test-agent', sub: 'did:imajin:test-principal',
      exp: Math.floor(Date.now() / 1000) + 60,
    })}`;
    const credential = `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${credential}` },
      body: '{"model":"test-model","messages":[],"stream":true}',
    });
  }

  it.each(['SIGTERM', 'SIGINT'] as const)('idle %s reports drain and exits 0 with the process group gone', async name => {
    await (await fetch(`${baseUrl}/healthz`)).text();
    signal(name);
    await assertExited(0, false);
  }, testTimeoutMs);

  it('SIGTERM lets an in-flight upstream stream complete 200 and exits 0 within grace', async () => {
    const response = await stream();
    const text = response.text();
    signal();
    await assertDraining(1);
    expect(child.exitCode, output).toBeNull();
    upstreamResponse.end('data: done\n\n');
    expect(response.status).toBe(200);
    expect(await text).toBe('data: first\n\ndata: done\n\n');
    await assertExited(1, false);
  }, testTimeoutMs);

  it('SIGTERM cuts a hung upstream at grace and exits 0 with the process group gone', async () => {
    const response = await stream();
    const text = response.text().catch(() => 'cut');
    signal();
    await assertExited(1, true);
    expect(response.status).toBe(200);
    expect(await text).toBe('cut');
  }, testTimeoutMs);

  it('a second signal skips the remaining grace', async () => {
    const response = await stream();
    const text = response.text().catch(() => 'cut');
    signal();
    await assertDraining(1);
    signal();
    await assertExited(1, false);
    expect(await text).toBe('cut');
  }, testTimeoutMs);
});
