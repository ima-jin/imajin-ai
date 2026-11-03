import { pathToFileURL } from 'node:url';

const PROTOCOL = '2025-06-18';
const didPattern = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]{1,200}$/;
const scopePattern = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

function endpoint(value) {
  const url = new URL(value ?? 'https://mcp.imajin.ai');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error();
  if (url.username || url.password || url.search || url.hash || !['/', '/mcp'].includes(url.pathname)) throw new Error();
  return new URL('/mcp', url).toString();
}

/** Decode for comparison only; the server, never this decoder, verifies authority. */
function safeClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error();
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof claims.sub !== 'string' || !didPattern.test(claims.sub)
    || typeof claims.scope !== 'string' || typeof claims.acting_for !== 'string'
    || !didPattern.test(claims.acting_for)) throw new Error();
  const scopes = [...new Set(claims.scope.split(/\s+/).filter(Boolean))];
  if (scopes.length === 0 || !scopes.every(scope => scopePattern.test(scope))) throw new Error();
  return { did: claims.sub, scopes, principal: claims.acting_for };
}

/** No registration, refresh, writes, provider calls, response bodies, or error logs. */
export async function gatewaySmoke({ env = process.env, fetcher = fetch } = {}) {
  let did = null;
  let scopes = [];
  try {
    const token = env.MCP_ACCESS_TOKEN;
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error();
    const target = endpoint(env.MCP_BASE_URL);
    const claims = safeClaims(token);
    if (!env.MCP_EXPECTED_DID || !env.MCP_EXPECTED_PRINCIPAL
      || claims.did !== env.MCP_EXPECTED_DID || claims.principal !== env.MCP_EXPECTED_PRINCIPAL) throw new Error();
    let id = 0;
    async function rpc(method, params) {
      const requestId = ++id;
      const response = await fetcher(target, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          'MCP-Protocol-Version': PROTOCOL, Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || !body.result) throw new Error();
      return body.result;
    }
    const listed = await rpc('tools/list', {});
    if (!Array.isArray(listed.tools) || !listed.tools.some(tool => tool.name === 'ping')) throw new Error();
    const called = await rpc('tools/call', { name: 'ping', arguments: {} });
    if (called.isError || !Array.isArray(called.content)
      || !called.content.some(item => item.type === 'text' && typeof item.text === 'string'
        && item.text.startsWith(`pong — authenticated as ${claims.did} at `))) throw new Error();
    did = claims.did;
    scopes = claims.scopes;
    return { did, scopes, result: 'PASS' };
  } catch {
    // Even fetch/JSON errors may contain credentials or provider bodies.
    return { did, scopes, result: 'FAIL' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await gatewaySmoke();
  console.log(JSON.stringify(result));
  process.exitCode = result.result === 'PASS' ? 0 : 1;
}
