import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createProxyServer } from '../../../../../../packages/openclaw-infer-passthrough/src/server.js';
import { loadConfig } from '../../../../../../packages/openclaw-infer-passthrough/src/config.js';

const runtime = vi.hoisted(() => ({ allowed: true, token: '', audit: vi.fn(), upstream: vi.fn() }));
vi.mock('../git-authority', () => ({
  gitAuthority: async () => runtime.allowed ? { actorDid: 'did:imajin:agent', ownerDid: 'did:imajin:owner', grantId: 'fixture' } : 403,
}));
vi.mock('../connector', async () => {
  const { fetchGitRead } = await import('../git-http');
  return { readGitRepository: (_owner: string, req: Request, target: Parameters<typeof fetchGitRead>[1]) => fetchGitRead(req, target, runtime.token) };
});
vi.mock('@/src/db', () => ({ db: { insert: () => ({ values: runtime.audit }) }, attestations: {} }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: async (value: unknown) => value }));
import { githubGitRoute } from '../git-route';

let directory: string;
let repository: string;
let checkout: string;
let kernel: Server;
let proxy: Server;
let localUrl: string;
let jwt: string;
const realFetch = globalThis.fetch;

function git(args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = execFile('git', args, { env, encoding: 'buffer', timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString()));
      else resolve(stdout);
    });
    process.stdin?.end(input);
  });
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function boxEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: `url.${localUrl}/github/git/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_CONFIG_KEY_1: `http.${localUrl}/github/git/.extraHeader`, GIT_CONFIG_VALUE_1: `Authorization: Bearer ${jwt}`,
    GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
  };
}
async function commitFixture(): Promise<void> {
  await git(['-C', repository, 'add', 'content.txt']);
  await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-m', 'test fixture', '-m', 'Co-Authored-By: Warp <agent@warp.dev>']);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'imajin-git-3405-'));
  repository = join(directory, 'origin');
  checkout = join(directory, 'box-checkout');
  runtime.token = randomBytes(32).toString('hex');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'app+jwt', alg: 'EdDSA' })}.${encode({
    azp: 'did:imajin:agent', sub: 'did:imajin:owner', exp: Date.now() / 1000 + 600,
  })}`;
  jwt = `${unsigned}.${sign(null, Buffer.from(unsigned), generateKeyPairSync('ed25519').privateKey).toString('base64url')}`;
  await git(['init', '--initial-branch=main', repository]);
  await writeFile(join(repository, 'content.txt'), 'first\n');
  await commitFixture();
  kernel = createServer((req, res) => {
    void (async () => {
      const response = await githubGitRoute(new Request(`http://kernel.test${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        body: req.method === 'POST' ? Readable.toWeb(req) : undefined, duplex: 'half',
      } as RequestInit));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    })().catch(() => res.destroy());
  });
  const kernelUrl = await listen(kernel);
  proxy = createProxyServer(loadConfig({ KERNEL_BASE_URL: kernelUrl }));
  localUrl = await listen(proxy);
  runtime.upstream.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url.startsWith('https://github.com/ima-jin/private.git/')).toBe(true);
    expect(new Headers(init.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from(`x-access-token:${runtime.token}`).toString('base64')}`);
    if (url.endsWith('info/refs?service=git-upload-pack')) {
      const refs = await git(['upload-pack', '--stateless-rpc', '--advertise-refs', repository]);
      return new Response(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), refs]), {
        headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
      });
    }
    expect(url.endsWith('/git-upload-pack')).toBe(true);
    const input = Buffer.from(await new Response(init.body).arrayBuffer());
    return new Response(await git(['upload-pack', '--stateless-rpc', repository], process.env, input), {
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    });
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => url.startsWith('https://github.com/')
    ? runtime.upstream(url, init) : realFetch(url, init));
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const server of [proxy, kernel]) {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('real git clones/pulls through both HTTP boundaries, denies push/revoke, and leaves no credential on disk', async () => {
  const env = boxEnvironment();
  await git(['clone', 'https://github.com/ima-jin/private.git', checkout], env);
  expect((await readFile(join(checkout, 'content.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('first\n');
  await writeFile(join(repository, 'content.txt'), 'second\n');
  await commitFixture();
  await git(['-C', checkout, 'pull', '--ff-only'], env);
  expect((await readFile(join(checkout, 'content.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('second\n');
  const beforePush = runtime.upstream.mock.calls.length;
  await expect(git(['-C', checkout, 'push', '--dry-run'], env)).rejects.toThrow('403');
  expect(runtime.upstream).toHaveBeenCalledTimes(beforePush);
  runtime.allowed = false;
  await expect(git(['-C', checkout, 'fetch'], env)).rejects.toThrow('403');
  const config = await readFile(join(checkout, '.git', 'config'), 'utf8');
  expect(config).not.toContain(runtime.token);
  expect(config).not.toContain(jwt);
  expect(config).toContain('https://github.com/ima-jin/private.git');
  expect(runtime.audit).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({ actorDid: 'did:imajin:agent', ownerDid: 'did:imajin:owner' }),
  }));
}, 30_000);
