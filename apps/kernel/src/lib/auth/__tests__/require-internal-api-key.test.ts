/**
 * Unit tests for the shared internal-API-key auth preamble (#1999).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { requireInternalApiKey } from '../require-internal-api-key';

const API_KEY = 'attestation-internal-key';

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
  process.env.ATTESTATION_INTERNAL_API_KEY = API_KEY;
});

describe('requireInternalApiKey', () => {
  it('returns null (authorized) when the Bearer token matches', () => {
    expect(requireInternalApiKey(makeRequest(API_KEY))).toBeNull();
  });

  it('returns a 401 with { error: "Unauthorized" } when the key does not match', async () => {
    const result = requireInternalApiKey(makeRequest('wrong-key'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    expect(await result!.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when no Authorization header is present', () => {
    const result = requireInternalApiKey(makeRequest(undefined));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when ATTESTATION_INTERNAL_API_KEY is not configured server-side, even if a key is sent', () => {
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    const result = requireInternalApiKey(makeRequest(API_KEY));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('accepts a bare (non-Bearer) Authorization header value equal to the key', () => {
    const result = requireInternalApiKey(makeRequestWithRawHeader(API_KEY));
    expect(result).toBeNull();
  });

  it('rejects a bare Authorization header value that does not match', () => {
    const result = requireInternalApiKey(makeRequestWithRawHeader('not-the-key'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});
