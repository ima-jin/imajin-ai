import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fetcher = vi.hoisted(() => vi.fn());
vi.mock('../egress-fetch', () => ({ egressSafeFetch: fetcher }));
import { forwardAppUpstream } from '../external-mcp-transport';
import { parseUpstream, upstreamDeclarations, upstreamCallInput } from '../app-upstream-policy';
const fake = 'FAKE_UPSTREAM_CREDENTIAL_NOT_VALID';
const target = parseUpstream(upstreamDeclarations, { upstreams: [{
  id: 'catalog', origin: 'https://api.example', paths: [{ path: '/items', methods: ['GET', 'POST'] }],
}] }).upstreams[0];
const call = parseUpstream(upstreamCallInput, {
  memberDid: 'did:imajin:member', upstreamId: 'catalog', path: '/items', method: 'GET',
});
beforeEach(() => { fetcher.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
it('shares bearer injection and preserves bounded non-JSON bodies and upstream error status', async () => {
  fetcher.mockResolvedValue(new Response('ordinary text', { status: 422 }));
  expect(await forwardAppUpstream(target, call, fake)).toEqual({ status: 422, body: 'ordinary text' });
  expect(fetcher).toHaveBeenCalledWith('https://api.example/items', {
    method: 'GET', body: undefined, headers: { Authorization: `Bearer ${fake}`, 'Content-Type': 'application/json' },
  }, { connector: 'app-upstream', timeoutMs: 30_000, allowPrivate: false });
});
it.each([
  () => new Response(fake),
  () => new Response(Buffer.from(fake).toString('base64')),
  () => new Response(Buffer.from(fake).toString('base64url')),
  () => new Response(JSON.stringify({ [fake]: 'echo' })),
  () => new Response(`{"echo":"${[...fake].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}`),
  () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
  () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  () => new Response(null),
])('refuses unsafe response without returning credential bytes %#', async reply => {
  fetcher.mockResolvedValue(reply());
  await expect(forwardAppUpstream(target, call, fake)).rejects.toMatchObject({
    status: 502, message: 'External MCP upstream unavailable',
  });
});
it.each(['HEAD', 'GET'])('handles %s empty-body success without exposing headers', async method => {
  fetcher.mockResolvedValue(new Response(null, { status: 204, headers: { 'x-debug': fake } }));
  expect(await forwardAppUpstream(target, { ...call, method: method as 'HEAD' | 'GET' }, fake)).toEqual({ status: 204, body: '' });
});
it('normalizes egress refusals and provider exceptions', async () => {
  fetcher.mockRejectedValue(new Error(fake));
  await expect(forwardAppUpstream(target, call, fake)).rejects.toThrow('External MCP upstream unavailable');
});
it('cancels a stalled response at the body deadline, refusing partial bytes', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  fetcher.mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('partial')); }, cancel,
  })));
  const result = expect(forwardAppUpstream(target, call, fake)).rejects.toThrow('External MCP upstream unavailable');
  await vi.advanceTimersByTimeAsync(30_001);
  await result;
  expect(cancel).toHaveBeenCalled();
});
