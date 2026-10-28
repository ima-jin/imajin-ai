import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forwardPostmanCall } from '../external-mcp-transport';
import { connectInput, parseExternalMcpCall } from '../external-mcp-policy';

const fake = 'FAKE_POSTMAN_CREDENTIAL_NOT_A_KEY';
const request = () => parseExternalMcpCall({
  jsonrpc: '2.0', id: 'client-id', method: 'tools/call',
  params: { name: 'getCollections', arguments: { workspace: 'bedrock' } },
});
const fetcher = vi.fn();
const reply = (id: number, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
function arrange(final: () => Response) {
  fetcher.mockImplementation(async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === 'initialize') return new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' },
    }), { headers: { 'mcp-session-id': 'private-session' } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return final();
  });
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());

it('keeps session headers private and filters discovery with the exact allowlist', async () => {
  arrange(() => reply(2, { tools: [
    { name: 'getCollections' }, { name: 'getEnvironment' }, { name: 'getCollectionRequest' },
    { name: 'runCollection', annotations: { readOnlyHint: true } }, { name: 'createCollection' }, null,
  ] }));
  const result = await forwardPostmanCall(parseExternalMcpCall({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), fake);
  expect(result.result.tools).toEqual([{ name: 'getCollections' }, { name: 'getEnvironment' }, { name: 'getCollectionRequest' }]);
  expect(fetcher.mock.calls[2][1].headers['Mcp-Session-Id']).toBe('private-session');
  expect(JSON.stringify(result)).not.toContain('private-session');
  expect(JSON.stringify(result)).not.toContain(fake);
});
it('consumes split SSE events and cancels without waiting for a long-lived stream to close', async () => {
  const canceled = vi.fn();
  arrange(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","id":2,'));
      controller.enqueue(Buffer.from('"result":{"content":[{"type":"text","text":"Bedrock"}]}}\r\n\r\n'));
    },
    cancel: canceled,
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const result = await forwardPostmanCall(request(), fake);
  expect(result.id).toBe('client-id');
  expect(result.result.content).toEqual([{ type: 'text', text: 'Bedrock' }]);
  expect(canceled).toHaveBeenCalled();
});
it.each([
  () => reply(2, { content: [{ text: fake }] }),
  () => reply(2, { [fake]: 'value' }),
  () => reply(2, { content: [{ text: Buffer.from(fake).toString('base64') }] }),
  () => Response.json({ jsonrpc: '2.0', id: 2, error: { message: fake } }),
  () => reply(2, { isError: true, content: [{ text: fake }] }),
  () => new Response(fake, { status: 401 }),
  () => new Response(null, { status: 302, headers: { location: `https://attacker.test/${fake}` } }),
  () => new Response('not JSON'),
  () => reply(999, { content: [] }),
  () => reply(2, 'invalid-result'),
  () => new Response(null),
  () => reply(2, { content: [{ text: 'x'.repeat(2 * 1024 * 1024) }] }),
])('normalizes upstream failures and credential echoes without exposing bytes %#', async final => {
  arrange(final);
  await expect(forwardPostmanCall(request(), fake)).rejects.toMatchObject({
    status: 502, message: 'External MCP upstream unavailable',
  });
});
it.each(['initialize-error', 'wrong-version', 'notification-error', 'fetch-throw', 'malformed-list'])(
  'refuses transport boundary %s', async kind => {
    arrange(() => reply(2, {}));
    if (kind === 'initialize-error') fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    if (kind === 'wrong-version') fetcher.mockResolvedValue(reply(1, { protocolVersion: 'unsupported' }));
    if (kind === 'notification-error') fetcher.mockImplementation(async (_url, opts) =>
      JSON.parse(opts.body).method === 'initialize' ? reply(1, { protocolVersion: '2025-06-18' }) : new Response(null, { status: 400 }));
    if (kind === 'fetch-throw') fetcher.mockRejectedValue(new Error(fake));
    const call = kind === 'malformed-list'
      ? parseExternalMcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) : request();
    await expect(forwardPostmanCall(call, fake)).rejects.toThrow('External MCP upstream unavailable');
  });
it.each([
  null, [], { jsonrpc: '2.0', id: 1, method: 'resources/read' },
  { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { name: 'getCollection' } },
  { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { arguments: {} } },
  { jsonrpc: '2.0', id: 1, method: 'tools/list', url: 'https://attacker.test' },
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCollections', arguments: {} } },
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCollections', arguments: { workspace: 'w', limit: 100 } } },
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCollections', arguments: { workspace: 'w', offset: -1 } } },
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCollections', cursor: 'bad', arguments: { workspace: 'w' } } },
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCollection', arguments: { collectionId: 'c', headers: {} } } },
])('validates RPC and rejects protocol/header/URL overrides %#', input => {
  expect(() => parseExternalMcpCall(input)).toThrow();
});
it.each([
  ['getWorkspaces', {}], ['getWorkspace', { workspaceId: 'w' }],
  ['getCollection', { collectionId: 'c', model: 'full' }],
  ['getCollectionRequest', { collectionId: 'c', requestId: 'r', populate: true }],
  ['getEnvironments', {}], ['getEnvironment', { environmentId: 'e' }],
])('permits the reviewed saved-data read %s', (name, args) => {
  expect(parseExternalMcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).params?.name).toBe(name);
});
it('requires a printable nonempty key and a bounded org DID, and rejects unknown configuration', () => {
  for (const input of [{ secret: '' }, { secret: 'x'.repeat(4097) }, { secret: 'x y' }, { secret: '\t' },
    { secret: 'fake', orgContextDid: 'did:imajin:' }, { secret: 'fake', header: 'x-api-key' }]) {
    expect(connectInput.safeParse(input).success).toBe(false);
  }
});
it('refuses a caller-supplied RPC id that would echo the current credential', async () => {
  arrange(() => reply(2, { content: [] }));
  await expect(forwardPostmanCall({ ...request(), id: fake }, fake)).rejects.toThrow('External MCP upstream unavailable');
});
