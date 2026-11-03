import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These are real POSIX process-group signals, not Windows' forceful kill emulation.
describe.skipIf(process.platform !== 'linux')('standalone tsx process-group shutdown', () => {
  let child: ChildProcess;
  let upstream: Server;
  let upstreamResponse: ServerResponse;
  let output: string;
  let directory: string;
  let baseUrl: string;
  let childPids: number[];
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
      compilerOptions: { paths: { '@imajin/*': [resolve('packages/*/src/index.ts')] } },
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
      resolve('node_modules/tsx/dist/cli.mjs'), '--tsconfig', tsconfig,
      resolve('packages/openclaw-infer-passthrough/src/server.ts'),
    ], {
      detached: true,
      env: {
        PATH: process.env.PATH,
        KERNEL_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        INFER_PROXY_AUTH_MODE: 'agent', INFER_PROXY_PORT: String(port),
        INFER_PROXY_SHUTDOWN_GRACE_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { output += data.toString(); });
    await vi.waitFor(() => {
      expect(child.exitCode, output).toBeNull();
      expect(output).toContain('openclaw-infer-passthrough listening');
    }, { timeout: 10_000 });
    childPids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8'))
      .trim().split(/\s+/).map(Number);
    expect(childPids.length).toBeGreaterThan(0);
    expect(childPids.every(pid => pid > 0)).toBe(true);
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

  async function assertExited(started: number, boundMs: number) {
    expect(await Promise.race([exited, delay(boundMs).then(() => 'shutdown timed out')]), output)
      .toEqual({ code: 0, signal: null });
    expect(performance.now() - started).toBeLessThan(boundMs);
    for (const pid of [child.pid!, ...childPids]) {
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    }
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

  it.each(['SIGTERM', 'SIGINT'] as const)('idle %s exits 0 with both PIDs gone in < 1s', async name => {
    await (await fetch(`${baseUrl}/healthz`)).text();
    const started = performance.now();
    signal(name);
    await assertExited(started, 1000);
  });

  it('SIGTERM lets an in-flight upstream stream complete 200 and exits 0 within grace', async () => {
    const response = await stream();
    const text = response.text();
    const started = performance.now();
    signal();
    await vi.waitFor(() => expect(output).toContain('passthrough draining'));
    await delay(100);
    expect(child.exitCode).toBeNull();
    upstreamResponse.end('data: done\n\n');
    expect(response.status).toBe(200);
    expect(await text).toBe('data: first\n\ndata: done\n\n');
    await assertExited(started, 1000);
    expect(output).toContain('"inFlightAtSignal":1,"cutAtGrace":false');
  });

  it('SIGTERM cuts a hung upstream at grace and exits 0 without a lingering wrapper', async () => {
    const response = await stream();
    const text = response.text().catch(() => 'cut');
    const started = performance.now();
    signal();
    await assertExited(started, 1800);
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    expect(await text).toBe('cut');
    expect(output).toContain('"inFlightAtSignal":1,"cutAtGrace":true');
  });

  it('a second signal skips the remaining grace', async () => {
    const response = await stream();
    const text = response.text().catch(() => 'cut');
    signal();
    await vi.waitFor(() => expect(output).toContain('passthrough draining'));
    const started = performance.now();
    signal();
    await assertExited(started, 500);
    expect(await text).toBe('cut');
  });
});
