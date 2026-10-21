import { afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => vi.fn());
vi.mock('../../kernel/egress-fetch', () => ({ egressSafeFetch: transport }));
vi.mock('../../kernel/api-specs', () => ({ SPEC_MAX_CHARS: 400_000 }));
import { loadRegistryEdgeSpec } from '../edge-spec-loader';

afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('read-only registry spec egress', () => {
  it('uses the existing pinned guard without credentials and parses YAML', async () => {
    transport.mockResolvedValue(new Response('paths:\n  /api/health:\n    get: {}'));
    expect(await loadRegistryEdgeSpec('https://apps.example.test/events/api/spec')).toMatchObject({ paths: { '/api/health': { get: {} } } });
    expect(transport).toHaveBeenCalledWith('https://apps.example.test/events/api/spec',
      { method: 'GET', headers: { Accept: 'application/yaml, application/json' } },
      { connector: 'edge-spec', timeoutMs: 5_000 });
  });
  it.each(['http://example.test/spec', 'https://user@example.test/spec', 'https://example.test/spec?token=fixture', 'https://example.test/spec#fragment'])('refuses unsafe URL shape %s before egress', async url => {
    await expect(loadRegistryEdgeSpec(url)).rejects.toThrow('Invalid');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([302, 403, 500])('refuses status %s rather than following a redirect', async status => {
    transport.mockResolvedValue(new Response('fixture', { status }));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('unavailable');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('refuses missing bodies and oversized declared or streamed content', async () => {
    transport.mockResolvedValueOnce(new Response(null));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('unavailable');
    transport.mockResolvedValueOnce(new Response('fixture', { headers: { 'content-length': '400001' } }));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('unavailable');
    transport.mockResolvedValueOnce(new Response('x'.repeat(400_001)));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('too large');
  });
  it('rejects malformed YAML and propagates denied egress', async () => {
    transport.mockResolvedValueOnce(new Response('paths: ['));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow();
    transport.mockRejectedValueOnce(new Error('egress denied'));
    await expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('egress denied');
  });
  it('bounds a stalled response body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    transport.mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
    const pending = expect(loadRegistryEdgeSpec('https://example.test/spec')).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(5_001);
    await pending;
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
