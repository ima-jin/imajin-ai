/**
 * Tests for the operator-executed provisioner runner (#1933).
 *
 * The dry-run tests are the load-bearing ones for this package: nothing in
 * CI should ever shell out to `docker` or write real files, so every
 * assertion about "no side effect happened" matters as much as the
 * happy-path assertions about what a real run *would* do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProvision, type ProvisionRecord } from '../src/runner';
import * as publicApi from '../src/index';

function makeProvision(overrides: Partial<ProvisionRecord> = {}): ProvisionRecord {
  return {
    id: 'prov_1',
    servingDid: 'did:imajin:ryan',
    agentDid: 'did:imajin:agent-x',
    handle: 'travel-agent-abc123',
    harness: 'nanoclaw',
    placement: 'hosted',
    model: { provider: 'anthropic:claude', via: 'kernel-passthrough' },
    scopes: ['messages:write'],
    status: 'awaiting_boot',
    ...overrides,
  };
}

function fakeFetch(provision: ProvisionRecord) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/callback')) {
      return { ok: true, status: 200, json: async () => ({ provision: { ...provision, status: 'booted' } }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ provision }) } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claw-provisioner-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('package barrel export (src/index.ts)', () => {
  it('re-exports runProvision', () => {
    expect(publicApi.runProvision).toBe(runProvision);
  });
});

describe('runProvision — dry-run safety', () => {
  it('writes no files, runs no compose command, and sends no callback under --dry-run', async () => {
    const provision = makeProvision();
    const { impl, calls } = fakeFetch(provision);
    const execCompose = vi.fn();

    const result = await runProvision({
      kernelBaseUrl: 'https://kernel.test',
      provisionId: 'prov_1',
      operatorToken: 'owner-token',
      runnerToken: 'runner-secret',
      dryRun: true,
      fetchImpl: impl,
      execCompose,
    });

    expect(execCompose).not.toHaveBeenCalled();
    expect(result.composeRan).toBe(false);
    expect(result.callbackSent).toBe(false);
    expect(result.filesWritten.length).toBeGreaterThan(0);
    // Only the provision GET happened — no callback POST.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/auth/api/agents/provision/prov_1');
  });

  it('reports the planned file paths under dry-run without touching the filesystem', async () => {
    const provision = makeProvision({ placement: 'local' });
    const { impl } = fakeFetch(provision);
    const outDir = join(tmpdir(), 'claw-provisioner-test-never-created', 'rendered');

    const result = await runProvision({
      kernelBaseUrl: 'https://kernel.test',
      provisionId: 'prov_1',
      operatorToken: 'owner-token',
      dryRun: true,
      outDir,
      fetchImpl: impl,
    });

    expect(result.filesWritten.some((p) => p.includes('SOUL.md'))).toBe(true);
    expect(result.outDir).toBe(outDir);
  });
});

describe('runProvision — hosted, non-dry-run', () => {
  it('runs compose build+up and sends the boot-status callback', async () => {
    const provision = makeProvision();
    const { impl, calls } = fakeFetch(provision);
    const execCompose = vi.fn().mockResolvedValue(undefined);

    const outDir = makeTempDir();
    const composeDir = makeTempDir();
    const result = await runProvision({
      kernelBaseUrl: 'https://kernel.test',
      provisionId: 'prov_1',
      operatorToken: 'owner-token',
      runnerToken: 'runner-secret',
      outDir,
      composeDir,
      fetchImpl: impl,
      execCompose,
    });

    expect(execCompose).toHaveBeenNthCalledWith(1, ['build'], composeDir);
    expect(execCompose).toHaveBeenNthCalledWith(2, ['up', '-d'], composeDir);
    expect(result.composeRan).toBe(true);
    expect(result.callbackSent).toBe(true);

    const callback = calls.find((c) => c.url.endsWith('/callback'));
    expect(callback).toBeTruthy();
    expect(callback?.init?.headers).toMatchObject({ 'x-provisioner-runner-token': 'runner-secret' });
    expect(JSON.parse(String(callback?.init?.body))).toEqual({ status: 'booted' });
  });

  it('does not run compose or send a callback for a local placement', async () => {
    const provision = makeProvision({ placement: 'local' });
    const { impl, calls } = fakeFetch(provision);
    const execCompose = vi.fn();

    const result = await runProvision({
      kernelBaseUrl: 'https://kernel.test',
      provisionId: 'prov_1',
      operatorToken: 'owner-token',
      runnerToken: 'runner-secret',
      outDir: makeTempDir(),
      fetchImpl: impl,
      execCompose,
    });

    expect(execCompose).not.toHaveBeenCalled();
    expect(result.composeRan).toBe(false);
    expect(result.callbackSent).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/callback'))).toBe(false);
  });
});

describe('runProvision — validation', () => {
  it('throws for a harness other than nanoclaw (openclaw stub)', async () => {
    const provision = makeProvision({ harness: 'openclaw' });
    const { impl } = fakeFetch(provision);

    await expect(
      runProvision({ kernelBaseUrl: 'https://kernel.test', provisionId: 'prov_1', operatorToken: 'x', dryRun: true, fetchImpl: impl }),
    ).rejects.toThrow(/not yet implemented/);
  });

  it('throws when the provision has no agent identity yet', async () => {
    const provision = makeProvision({ agentDid: null, status: 'pending' });
    const { impl } = fakeFetch(provision);

    await expect(
      runProvision({ kernelBaseUrl: 'https://kernel.test', provisionId: 'prov_1', operatorToken: 'x', dryRun: true, fetchImpl: impl }),
    ).rejects.toThrow(/no agent identity yet/);
  });

  it('throws when the provision fetch fails', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);

    await expect(
      runProvision({ kernelBaseUrl: 'https://kernel.test', provisionId: 'prov_missing', operatorToken: 'x', dryRun: true, fetchImpl: impl as unknown as typeof fetch }),
    ).rejects.toThrow(/Failed to fetch provision/);
  });

  it('rejects a provision handle that fails the safe-path-segment allow-list (e.g. path traversal)', async () => {
    const provision = makeProvision({ handle: '../../etc/passwd' });
    const { impl } = fakeFetch(provision);

    await expect(
      runProvision({ kernelBaseUrl: 'https://kernel.test', provisionId: 'prov_1', operatorToken: 'x', dryRun: true, fetchImpl: impl }),
    ).rejects.toThrow(/unexpected characters/);
  });
});
