/**
 * Tests for `mapUpstreamErrorToHttp` (#1925, extended #1957).
 *
 * `fetchUpstream` itself is exercised indirectly by
 * `openai-compatible-adapter.test.ts` (the xAI branch) and by
 * `egress-fetch.test.ts` (the `local` branch's typed timeout/unavailable
 * errors) — this file is about the mapper alone.
 */
import { describe, it, expect } from 'vitest';
import { UpstreamTimeoutError, UpstreamUnavailableError, mapUpstreamErrorToHttp } from '../errors';

describe('mapUpstreamErrorToHttp', () => {
  it('maps UpstreamTimeoutError to 504', () => {
    const mapped = mapUpstreamErrorToHttp(new UpstreamTimeoutError('local'));
    expect(mapped).toMatchObject({ status: 504, body: { error: 'upstream_timeout' } });
  });

  it('maps UpstreamUnavailableError to 502', () => {
    const mapped = mapUpstreamErrorToHttp(new UpstreamUnavailableError('local', 'ECONNREFUSED'));
    expect(mapped).toMatchObject({ status: 502, body: { error: 'upstream_unavailable' } });
    expect(mapped?.body['detail']).toContain('ECONNREFUSED');
  });

  /**
   * #1957: only reachable if a sealed `local` connection somehow lost its
   * pinned address between resolution and forwarding (e.g. a corrupted
   * vault field) — `egressSafeFetch`'s fallback re-validation then denies
   * it. Matched by `.name` (not `instanceof`) to avoid a circular import
   * between this module and `egress-fetch.ts` — see the mapper's own
   * comment.
   */
  it('maps an EgressDeniedError (matched by name) to 502', () => {
    const egressDenied = new Error('egress_denied: private range not allowlisted');
    egressDenied.name = 'EgressDeniedError';

    const mapped = mapUpstreamErrorToHttp(egressDenied);

    expect(mapped).toMatchObject({ status: 502, body: { error: 'upstream_unavailable' } });
    expect(mapped?.body['detail']).toContain('egress_denied');
  });

  it('returns undefined for an unrelated error', () => {
    expect(mapUpstreamErrorToHttp(new Error('something else'))).toBeUndefined();
    expect(mapUpstreamErrorToHttp('not even an error')).toBeUndefined();
  });
});
