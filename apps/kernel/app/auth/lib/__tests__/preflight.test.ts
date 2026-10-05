/**
 * Shared CORS preflight handler (#2562): every kernel auth route re-exports it
 * as `OPTIONS`, so the 204 + CORS-header contract is pinned here once.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { preflight } from '../preflight';

function makeRequest(origin?: string): NextRequest {
  return new NextRequest('https://test.imajin.ai/auth/api/x', {
    method: 'OPTIONS',
    headers: origin ? { origin } : {},
  });
}

describe('preflight', () => {
  it('responds 204 with an empty body', async () => {
    const res = preflight(makeRequest('https://test.imajin.ai'));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('is synchronous (returns a Response, not a Promise)', () => {
    const res = preflight(makeRequest('https://test.imajin.ai'));

    expect(res).toBeInstanceOf(Response);
    expect(res).not.toBeInstanceOf(Promise);
  });

  it('echoes an allowed origin with credentials enabled', () => {
    const res = preflight(makeRequest('https://test.imajin.ai'));

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('blanks Access-Control-Allow-Origin for a disallowed origin', () => {
    const res = preflight(makeRequest('https://evil.example.com'));

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
  });

  it('sends exactly the headers corsHeaders() produces for the request', () => {
    const request = makeRequest('https://test.imajin.ai');
    const res = preflight(request);

    for (const [key, value] of Object.entries(corsHeaders(request))) {
      expect(res.headers.get(key)).toBe(value);
    }
  });
});
