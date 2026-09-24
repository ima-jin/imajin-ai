/**
 * Unit tests for the shared internal-API-key auth preamble (#1999, made
 * vault-sourced with a deprecated env fallback in #2245).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getInternalSecretMock } = vi.hoisted(() => ({
  getInternalSecretMock: vi.fn(),
}));

vi.mock('../../vault/internal-secret', () => ({
  getInternalSecret: getInternalSecretMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { requireInternalApiKey } from '../require-internal-api-key';

const VAULT_KEY = 'vault-sourced-attestation-key';
const LEGACY_KEY = 'legacy-env-attestation-key';

function makeRequest(apiKey: string | undefined): NextRequest {
  const headers = new Headers();
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`);
  return { headers } as unknown as NextRequest;
}

function makeRequestWithRawHeader(rawAuthHeader: string): NextRequest {
  const headers = new Headers({ authorization: rawAuthHeader });
  return { headers } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getInternalSecretMock.mockReset().mockResolvedValue(VAULT_KEY);
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
});

describe('requireInternalApiKey', () => {
  it('returns null (authorized) when the Bearer token matches the vault-sourced key', async () => {
    expect(await requireInternalApiKey(makeRequest(VAULT_KEY))).toBeNull();
    expect(getInternalSecretMock).toHaveBeenCalledWith('kernel.attestation-internal-api-key');
  });

  it('returns a 401 with { error: "Unauthorized" } when the key matches neither the vault-sourced nor legacy key', async () => {
    const result = await requireInternalApiKey(makeRequest('wrong-key'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    expect(await result!.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when no Authorization header is present', async () => {
    const result = await requireInternalApiKey(makeRequest(undefined));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    // Never even asks the vault for a key with nothing to compare against.
    expect(getInternalSecretMock).not.toHaveBeenCalled();
  });

  it('accepts a bare (non-Bearer) Authorization header value equal to the vault-sourced key', async () => {
    const result = await requireInternalApiKey(makeRequestWithRawHeader(VAULT_KEY));
    expect(result).toBeNull();
  });

  it('rejects a bare Authorization header value that does not match', async () => {
    const result = await requireInternalApiKey(makeRequestWithRawHeader('not-the-key'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('falls back to the deprecated ATTESTATION_INTERNAL_API_KEY env var when the caller sends that value instead (#2245 migration window)', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = LEGACY_KEY;
    expect(await requireInternalApiKey(makeRequest(LEGACY_KEY))).toBeNull();
  });

  it('rejects the legacy key when no ATTESTATION_INTERNAL_API_KEY env var is configured', async () => {
    const result = await requireInternalApiKey(makeRequest(LEGACY_KEY));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('fails closed (401) — never falls through to an open check — when getInternalSecret rejects and no legacy env var is set', async () => {
    getInternalSecretMock.mockReset().mockRejectedValue(new Error('vault unavailable'));
    const result = await requireInternalApiKey(makeRequest(VAULT_KEY));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('still accepts the deprecated legacy key when getInternalSecret rejects', async () => {
    getInternalSecretMock.mockReset().mockRejectedValue(new Error('vault unavailable'));
    process.env.ATTESTATION_INTERNAL_API_KEY = LEGACY_KEY;
    expect(await requireInternalApiKey(makeRequest(LEGACY_KEY))).toBeNull();
  });
});
