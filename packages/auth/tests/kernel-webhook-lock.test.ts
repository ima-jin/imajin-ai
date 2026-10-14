import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileKernelWebhookPinStore, verifyKernelWebhook } from '../src/kernel-webhook';
import { withKernelPinLock } from '../src/kernel-webhook-lock';

const namespace = 'https://kernel.example/auth';
const digest = createHash('sha256').update(namespace).digest('hex');
const source = resolve('packages/auth/src/kernel-webhook.ts');

function childStore(directory: string, hold: boolean) {
  const code = `
import { createFileKernelWebhookPinStore } from ${JSON.stringify(source)};
const store = createFileKernelWebhookPinStore(${JSON.stringify(directory)});
console.log('waiting');
await store.withLock(${JSON.stringify(namespace)}, async () => {
  console.log('acquired');
  ${hold ? "await new Promise(resolve => { process.stdin.resume(); process.stdin.on('end', resolve); });" : ''}
});
`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { errors += data.toString(); });
  return { child, output: () => output, errors: () => errors };
}

async function waitFor(child: ReturnType<typeof childStore>, text: string) {
  await vi.waitFor(() => {
    expect(child.child.exitCode, child.errors()).toBeNull();
    expect(child.output()).toContain(text);
  }, { timeout: 5_000, interval: 10 });
}

async function release(child: ChildProcessWithoutNullStreams) {
  const exit = once(child, 'exit');
  child.stdin.end();
  const [code] = await exit;
  expect(code).toBe(0);
}

describe('kernel public pin OS advisory locks', () => {
  it.each([
    '',
    'malformed legacy metadata',
    JSON.stringify({ pid: 2147483647, host: 'dead-host', timestamp: 1, token: 'dead-owner' }),
  ])('recovers old legacy/dead-owner files without deleting pins or lock inode: %j', async (contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-legacy-'));
    const lockPath = join(directory, `${digest}.json.lock`);
    const pinPath = join(directory, `${digest}.json`);
    await writeFile(lockPath, contents);
    await utimes(lockPath, new Date(0), new Date(0));
    await writeFile(pinPath, '["preserved-public-pin"]');
    const inode = (await stat(lockPath)).ino;
    const store = createFileKernelWebhookPinStore(directory);
    await store.withLock(namespace, async () => {
      expect(await store.load(namespace)).toEqual(['preserved-public-pin']);
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
        pid: process.pid, host: expect.any(String), timestamp: expect.any(Number), token: expect.any(String),
      });
    });
    expect((await stat(lockPath)).ino).toBe(inode);
    expect(await readFile(pinPath, 'utf8')).toBe('["preserved-public-pin"]');
  });

  it('SIGKILL owner releases for an independent process without manual deletion or pin loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-crash-'));
    const pinPath = join(directory, `${digest}.json`);
    const lockPath = `${pinPath}.lock`;
    await writeFile(pinPath, '["durable-anchor"]');
    const owner = childStore(directory, true);
    await waitFor(owner, 'acquired');
    const inode = (await stat(lockPath)).ino;
    const next = childStore(directory, false);
    await waitFor(next, 'waiting');
    await new Promise((done) => setTimeout(done, 100));
    expect(next.output()).not.toContain('acquired');
    const ownerExit = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await ownerExit;
    const nextExit = once(next.child, 'exit');
    await nextExit;
    expect(next.child.exitCode, next.errors()).toBe(0);
    expect(next.output()).toContain('acquired');
    expect((await stat(lockPath)).ino).toBe(inode);
    expect(await readFile(pinPath, 'utf8')).toBe('["durable-anchor"]');
  }, 15_000);

  it('active owners exclude contenders; predecessor release never removes successor ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-successor-'));
    const lockPath = join(directory, `${digest}.json.lock`);
    const first = childStore(directory, true);
    await waitFor(first, 'acquired');
    const before = JSON.parse(await readFile(lockPath, 'utf8'));
    const successor = childStore(directory, true);
    await waitFor(successor, 'waiting');
    await new Promise((done) => setTimeout(done, 100));
    expect(successor.output()).not.toContain('acquired');
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe(before.token);
    await release(first.child);
    await waitFor(successor, 'acquired');
    const successorOwner = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(successorOwner.token).not.toBe(before.token);
    const third = childStore(directory, false);
    await waitFor(third, 'waiting');
    await new Promise((done) => setTimeout(done, 100));
    expect(third.output()).not.toContain('acquired');
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe(successorOwner.token);
    const thirdExit = once(third.child, 'exit');
    await release(successor.child);
    await thirdExit;
    expect(third.child.exitCode, third.errors()).toBe(0);
    expect(third.output()).toContain('acquired');
  }, 15_000);

  it('releases after operation failure and permits the next owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-throw-'));
    const path = join(directory, 'test.lock');
    await expect(withKernelPinLock(path, async () => { throw new Error('operation failed'); }))
      .rejects.toThrow('operation failed');
    await expect(withKernelPinLock(path, async () => 42)).resolves.toBe(42);
  });
  it('bounds active-owner contention at ten seconds without breaking the live lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-timeout-'));
    const owner = childStore(directory, true);
    await waitFor(owner, 'acquired');
    const path = join(directory, `${digest}.json.lock`);
    const metadata = await readFile(path, 'utf8');
    const operation = vi.fn(async () => true);
    const started = Date.now();
    try {
      await expect(withKernelPinLock(path, operation)).rejects.toThrow('Kernel pin OS lock unavailable or timed out');
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_900);
      expect(Date.now() - started).toBeLessThan(13_000);
      expect(operation).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(metadata);
      expect(owner.child.exitCode).toBeNull();
    } finally {
      await release(owner.child);
    }
  }, 20_000);

  it('fails typed STORE when flock is missing; never falls back to unsafe lockfiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-unavailable-'));
    vi.stubEnv('PATH', '');
    try {
      const request = new Request('https://app.example/webhook', {
        method: 'POST', body: '{}',
        headers: {
          'x-kernel-audience': 'did:imajin:test',
          'x-kernel-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-kernel-nonce': '8fd641eb-18bd-4bd2-bf1b-32c23858b38a',
          'x-kernel-kid': 'auth-0123456789abcdef',
          'x-kernel-signature': '0'.repeat(128),
        },
      });
      await expect(verifyKernelWebhook(request, {
        audience: 'did:imajin:test', authServiceUrl: namespace,
        pinStore: createFileKernelWebhookPinStore(directory),
      })).rejects.toMatchObject({ code: 'STORE' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed when the parent cannot create the lock path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-invalid-'));
    await expect(withKernelPinLock(join(directory, 'missing', 'lock'), async () => true))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails closed on unexpected acquisition helper exit without invoking the operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kernel-lock-helper-exit-'));
    await writeFile(join(directory, 'flock'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    const lockPath = join(directory, 'test.lock');
    await writeFile(lockPath, 'legacy-owner');
    vi.stubEnv('PATH', directory);
    const operation = vi.fn(async () => true);
    try {
      await expect(withKernelPinLock(lockPath, operation))
        .rejects.toThrow('Kernel pin OS lock unavailable or timed out');
      expect(operation).not.toHaveBeenCalled();
      expect(await readFile(lockPath, 'utf8')).toBe('legacy-owner');
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(withKernelPinLock(lockPath, operation)).resolves.toBe(true);
  });
});
