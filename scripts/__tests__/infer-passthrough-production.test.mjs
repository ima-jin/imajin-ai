import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionApproved, verifyProduction } from '../../deploy/infer-passthrough/production-deployment.mjs';

const SHA = 'a'.repeat(40);
const deployment = (id = 1, overrides = {}) => ({ id, sha: SHA, environment: 'production', ...overrides });
// Not a real credential; never contacts GitHub in tests.
const fixtureCredential = 'non-secret-test-fixture';
let dir;
let request;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infer-production-'));
  writeFileSync(join(dir, 'github-token'), fixtureCredential);
  vi.stubEnv('CREDENTIALS_DIRECTORY', dir);
  request = vi.fn();
  vi.stubGlobal('fetch', request);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function replies(deployments, statuses = [{ state: 'success' }]) {
  request.mockResolvedValueOnce(Response.json(deployments))
    .mockResolvedValueOnce(Response.json(statuses));
}

describe('read-only exact-SHA production deployment gate (#3082)', () => {
  it('only reads production deployments for the exact SHA and their latest status', async () => {
    replies([deployment(17, { statuses_url: 'https://untrusted.test/credential-sink' })]);
    expect(await verifyProduction(SHA)).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[0];
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe('/repos/ima-jin/imajin-ai/deployments');
    expect(url.searchParams.get('sha')).toBe(SHA);
    expect(url.searchParams.get('environment')).toBe('production');
    expect(request.mock.calls[1][0].pathname).toBe('/repos/ima-jin/imajin-ai/deployments/17/statuses');
    expect(request.mock.calls[1][0].searchParams.get('per_page')).toBe('1');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    for (const [target, options] of request.mock.calls) {
      expect(target.origin).toBe('https://api.github.com');
      expect(options.headers.Authorization).toBe(`Bearer ${fixtureCredential}`);
      expect(options).not.toHaveProperty('body');
    }
  });

  it.each(['queued', 'pending', 'in_progress', 'failure', 'error', 'inactive'])('refuses latest status %s even with an older success', async (state) => {
    replies([deployment()], [{ state }, { state: 'success' }]);
    expect(await verifyProduction(SHA)).toBe(1);
  });

  it.each([
    { deployments: [] },
    { deployments: [deployment(1, { environment: 'staging' })] },
    { deployments: [deployment(1, { sha: 'b'.repeat(40) })] },
  ])('refuses absent or mismatched deployment evidence: %j', async ({ deployments }) => {
    request.mockResolvedValueOnce(Response.json(deployments));
    expect(await verifyProduction(SHA)).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a deployment with no status', async () => {
    replies([deployment()], []);
    expect(await verifyProduction(SHA)).toBe(1);
  });

  it('finds success on a second matching deployment only after checking its latest status', async () => {
    request.mockResolvedValueOnce(Response.json([deployment(1), deployment(2)]))
      .mockResolvedValueOnce(Response.json([{ state: 'failure' }]))
      .mockResolvedValueOnce(Response.json([{ state: 'success' }]));
    expect(await verifyProduction(SHA)).toBe(0);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('paginates the production deployment list before concluding there is no match', async () => {
    request.mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_, id) => deployment(id + 1, { environment: 'staging' }))))
      .mockResolvedValueOnce(Response.json([deployment()]))
      .mockResolvedValueOnce(Response.json([{ state: 'success' }]));
    expect(await verifyProduction(SHA)).toBe(0);
    expect(request.mock.calls[1][0].searchParams.get('page')).toBe('2');
  });

  it('fails closed on excessive pagination', async () => {
    request.mockImplementation(async () => Response.json(Array.from({ length: 100 }, () => ({ environment: 'staging' }))));
    await expect(productionApproved(SHA)).rejects.toThrow('pagination limit');
    expect(request).toHaveBeenCalledTimes(100);
  });

  it.each([401, 403, 429, 500])('fails closed on GitHub HTTP %s without printing its body', async (status) => {
    request.mockResolvedValueOnce(Response.json({ error: 'untrusted upstream body' }, { status }));
    expect(await verifyProduction(SHA)).toBe(2);
    expect(console.error.mock.calls.flat().join(' ')).not.toMatch(/untrusted|non-secret-test-fixture/);
  });

  it('fails closed on network or redirect errors without echoing details', async () => {
    request.mockRejectedValueOnce(new Error('untrusted upstream detail'));
    expect(await verifyProduction(SHA)).toBe(2);
    expect(console.error.mock.calls.flat().join(' ')).not.toContain('untrusted');
  });

  it.each([null, {}, 'not-an-array'])('refuses malformed deployment API responses: %j', async (body) => {
    request.mockResolvedValueOnce(Response.json(body));
    expect(await verifyProduction(SHA)).toBe(2);
  });

  it('refuses malformed status responses', async () => {
    replies([deployment()], { state: 'success' });
    expect(await verifyProduction(SHA)).toBe(2);
  });

  it.each([0, -1, 1.5, '1/other', Number.MAX_SAFE_INTEGER + 1])('refuses an invalid deployment ID: %s', async (id) => {
    request.mockResolvedValueOnce(Response.json([deployment(id)]));
    expect(await verifyProduction(SHA)).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', 'main', 'a'.repeat(39), 'a'.repeat(41), '../other'])('rejects invalid SHA before reading credentials: %s', async (sha) => {
    const readToken = vi.fn();
    await expect(productionApproved(sha, readToken)).rejects.toThrow('Invalid release SHA');
    expect(readToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed when the read-only credential is missing or empty', async () => {
    vi.stubEnv('CREDENTIALS_DIRECTORY', join(dir, 'missing'));
    expect(await verifyProduction(SHA)).toBe(2);
    vi.stubEnv('CREDENTIALS_DIRECTORY', dir);
    writeFileSync(join(dir, 'github-token'), '');
    expect(await verifyProduction(SHA)).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
});
