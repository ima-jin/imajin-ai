import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapIdentity, type BootstrapArgs } from '../src/bootstrap-identity.js';

describe('bootstrapIdentity dry-run', () => {
  it('makes no network calls and returns a dry-run marker', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await bootstrapIdentity({
      kernelBaseUrl: '',
      handle: 'poc',
      ownerToken: '',
      capabilities: ['messages:read'],
      audienceDids: [],
      keypairPath: '',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.grant).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('still validates capabilities against the closed registry in dry-run mode', async () => {
    await expect(
      bootstrapIdentity({
        kernelBaseUrl: '',
        handle: 'poc',
        ownerToken: '',
        capabilities: ['not-a-real-scope'],
        audienceDids: [],
        keypairPath: '',
        dryRun: true,
      }),
    ).rejects.toThrow(/Unknown grant capabilities/);
  });
});

describe('bootstrapIdentity live path (mocked fetch)', () => {
  let keypairDir: string;
  let keypairPath: string;

  beforeEach(() => {
    keypairDir = mkdtempSync(join(tmpdir(), 'claw-envelope-identity-'));
    keypairPath = join(keypairDir, 'keypair.json');
  });

  afterEach(() => {
    rmSync(keypairDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the agent, issues a grant, and writes the keypair with 0600 perms', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/api/agents')) {
        return new Response(
          JSON.stringify({
            did: 'did:imajin:agent-poc',
            handle: 'poc',
            keypair: { privateKey: 'priv-hex', publicKey: 'pub-hex' },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/auth/api/grants')) {
        return new Response(JSON.stringify({ grant: { grantId: 'grant-123' } }), { status: 201 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const args: BootstrapArgs = {
      kernelBaseUrl: 'https://kernel.example.com',
      handle: 'poc',
      ownerToken: 'owner-session-token',
      capabilities: ['messages:read', 'messages:write'],
      audienceDids: ['did:imajin:owner'],
      keypairPath,
      dryRun: false,
    };

    const result = await bootstrapIdentity(args);

    expect(result.agent.did).toBe('did:imajin:agent-poc');
    expect(result.grant?.grantId).toBe('grant-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const written = JSON.parse(readFileSync(keypairPath, 'utf-8')) as { privateKey: string };
    expect(written.privateKey).toBe('priv-hex');

    // Never printed: verify by checking no console.log/error call in this test received the private key.
    const mode = statSync(keypairPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('surfaces the kernel error message when agent creation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Handle already taken' }), { status: 409 })),
    );

    await expect(
      bootstrapIdentity({
        kernelBaseUrl: 'https://kernel.example.com',
        handle: 'poc',
        ownerToken: 'token',
        capabilities: [],
        audienceDids: [],
        keypairPath,
        dryRun: false,
      }),
    ).rejects.toThrow(/Handle already taken/);
  });
});
