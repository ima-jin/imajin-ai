import {
  allowedPostmanTool, ExternalMcpError, POSTMAN_MCP_URL, type ExternalMcpCall,
} from './external-mcp-policy';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const upstreamFailure = () => new ExternalMcpError(502, 'External MCP upstream unavailable');

/** Refuse echoes in keys, nested values, JSON-escaped text, URLs and base64. */
function containsCredential(value: unknown, credential: string): boolean {
  const serialized = JSON.stringify(value);
  return [credential, JSON.stringify(credential).slice(1, -1), encodeURIComponent(credential),
    Buffer.from(credential).toString('base64')].some(form => serialized.includes(form));
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw upstreamFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw upstreamFailure();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}

/** Streamable HTTP may return either JSON or SSE; neither is streamed to callers. */
async function readRpc(response: Response, id: number) {
  const text = await readBounded(response);
  const messages: unknown[] = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.replaceAll('\r\n', '\n').split('\n\n').filter(event => event.includes('data:'))
      .map(event => JSON.parse(event.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')))
    : [JSON.parse(text)];
  const message = messages.find(value => value && typeof value === 'object'
    && 'id' in value && value.id === id) as { jsonrpc?: string; result?: unknown; error?: unknown } | undefined;
  if (message?.jsonrpc !== '2.0' || message.error || !message.result || typeof message.result !== 'object') {
    throw upstreamFailure();
  }
  return message.result as Record<string, unknown>;
}

/** Credential lifetime is one call; headers/session identifiers never leave here. */
export async function forwardPostmanCall(call: ExternalMcpCall, credential: string) {
  try {
    const signal = AbortSignal.timeout(30_000);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const send = (message: unknown) => fetch(POSTMAN_MCP_URL, {
      method: 'POST', headers, body: JSON.stringify(message), signal,
      redirect: 'error', cache: 'no-store',
    });
    const initialized = await send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'imajin-kernel', version: '1.0' } },
    });
    if (!initialized.ok) throw upstreamFailure();
    const init = await readRpc(initialized, 1);
    if (init.protocolVersion !== '2025-06-18') throw upstreamFailure();
    const session = initialized.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    headers['MCP-Protocol-Version'] = '2025-06-18';
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await notification.body?.cancel();
    if (!notification.ok) throw upstreamFailure();
    const response = await send({ jsonrpc: '2.0', id: 2, method: call.method, params: call.params ?? {} });
    if (!response.ok) { await response.body?.cancel(); throw upstreamFailure(); }
    const result = await readRpc(response, 2);
    if (containsCredential(result, credential) || result.isError) throw upstreamFailure();
    if (call.method === 'tools/list') {
      if (!Array.isArray(result.tools)) throw upstreamFailure();
      result.tools = result.tools.filter(tool => tool && typeof tool.name === 'string' && allowedPostmanTool(tool.name));
    }
    return { jsonrpc: '2.0', id: call.id, result };
  } catch {
    // Neither provider messages nor thrown fetch errors are safe to log/return.
    throw upstreamFailure();
  }
}
