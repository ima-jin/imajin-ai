/**
 * Tests for the Warp route error mapping (#1428).
 *
 * These pin the distinction the routes depend on: a caller missing the grant gets
 * an actionable 403/409, whereas an upstream fault becomes a 502 that does not
 * invite the caller to re-authenticate against us.
 */
import { describe, it, expect } from 'vitest';
import { warpErrorResponse } from '../route-errors';
import { WarpApiError } from '../errors';

const CORS = { 'Access-Control-Allow-Origin': 'https://app.imajin.ai' };

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('gate failures are actionable', () => {
  it('maps a missing warp:dispatch grant to 403', async () => {
    const response = warpErrorResponse(new Error('warp_no_grant: DID has no active grant'), CORS);

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({ error: 'warp_no_grant' });
  });

  it('maps a missing or revoked sealed key to 409', async () => {
    const response = warpErrorResponse(new Error('warp_no_secret: nothing sealed'), CORS);

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({ error: 'warp_no_secret' });
  });

  it('maps caller input faults to 400', async () => {
    const response = warpErrorResponse(new Error('warp_invalid_prompt: empty'), CORS);
    expect(response.status).toBe(400);
  });

  it('carries the CORS headers through', () => {
    const response = warpErrorResponse(new Error('warp_no_grant: nope'), CORS);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

describe('upstream failures are reported as upstream', () => {
  it('passes a 4xx through with its problem metadata', async () => {
    const response = warpErrorResponse(
      new WarpApiError('warp_api_error: 402 Insufficient credits', {
        status: 402,
        code: 'insufficient_credits',
        detail: 'Team has no remaining add-on credits',
        retryable: false,
        traceId: 'trace-123',
      }),
      CORS,
    );

    expect(response.status).toBe(402);
    expect(await bodyOf(response)).toEqual({
      error: 'warp_upstream_error',
      upstreamStatus: 402,
      code: 'insufficient_credits',
      detail: 'Team has no remaining add-on credits',
      retryable: false,
      traceId: 'trace-123',
    });
  });

  it('does not echo an upstream 401 as our own 401', async () => {
    // A rejected Warp key is not something the caller can fix by re-authenticating
    // with us, so surfacing 401 here would send them down the wrong path.
    const response = warpErrorResponse(
      new WarpApiError('warp_api_error: 401 Not authorized', { status: 401 }),
      CORS,
    );

    expect(response.status).toBe(502);
    expect(await bodyOf(response)).toMatchObject({ upstreamStatus: 401 });
  });

  it('maps an upstream 5xx to 502', () => {
    const response = warpErrorResponse(
      new WarpApiError('warp_api_error: 500 boom', { status: 500 }),
      CORS,
    );
    expect(response.status).toBe(502);
  });

  it('omits problem fields that were absent rather than sending nulls', async () => {
    const response = warpErrorResponse(
      new WarpApiError('warp_api_error: 400 bad', { status: 400 }),
      CORS,
    );

    expect(await bodyOf(response)).toEqual({ error: 'warp_upstream_error', upstreamStatus: 400 });
  });
});

describe('unknown failures stay opaque', () => {
  it('does not leak an unexpected error message to the caller', async () => {
    const response = warpErrorResponse(new Error('Bearer sk-secret-value leaked into a stack'), CORS);

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'warp_dispatch_failed' });
  });
});
