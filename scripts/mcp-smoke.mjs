#!/usr/bin/env node
/**
 * MCP connector smoke harness (#1166) — repointed at our endpoint.
 *
 * Mirrors what the DFOS `/tmp/dfos_mcp.py` harness checks, against the kernel's
 * in-tree routes. Validates the parts that need NO token, then (if a token is
 * supplied) the authenticated ping path end-to-end.
 *
 * Usage:
 *   MCP_BASE_URL=http://localhost:3000 node scripts/mcp-smoke.mjs
 *   MCP_BASE_URL=https://mcp.imajin.ai MCP_ACCESS_TOKEN=<jwt> node scripts/mcp-smoke.mjs
 *
 * Obtaining MCP_ACCESS_TOKEN (forced order: migration 0051 + seed 0052 applied,
 * kernel running, and you logged in as a DID so /authorize has a session):
 *   1. Open in a logged-in browser:
 *      {BASE}/oauth/authorize?response_type=code&client_id=app_claude_desktop
 *        &redirect_uri=https://claude.ai/api/mcp/auth_callback
 *        &scope=media:read&state=xyz
 *        &code_challenge=<S256(verifier)>&code_challenge_method=S256
 *   2. Copy the `code` from the redirect, then exchange it:
 *      curl -s {BASE}/oauth/token -d grant_type=authorization_code -d code=<code> \
 *        -d client_id=app_claude_desktop \
 *        -d redirect_uri=https://claude.ai/api/mcp/auth_callback -d code_verifier=<verifier>
 *   3. Use the returned access_token as MCP_ACCESS_TOKEN.
 */

let BASE = process.env.MCP_BASE_URL || 'http://localhost:3000';
while (BASE.endsWith('/')) BASE = BASE.slice(0, -1);
const TOKEN = process.env.MCP_ACCESS_TOKEN || '';
const PROTOCOL = '2025-06-18';

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? '✓' : '✗';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${mark} ${label}${suffix}`);
  if (!cond) failures += 1;
}

async function rpc(method, params, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': PROTOCOL,
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`MCP smoke → ${BASE}\n`);

  // 1. Protected-resource metadata (RFC 9728)
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`).then((r) => r.json());
  check('protected-resource: has resource', !!prm.resource, prm.resource);
  check('protected-resource: lists authorization_servers', Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0);

  // 2. Authorization-server metadata (RFC 8414)
  const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check('as-metadata: authorization_endpoint', !!asm.authorization_endpoint);
  check('as-metadata: token_endpoint', !!asm.token_endpoint);
  check('as-metadata: S256 supported', (asm.code_challenge_methods_supported || []).includes('S256'));
  check('as-metadata: authorization_code grant', (asm.grant_types_supported || []).includes('authorization_code'));
  check('as-metadata: refresh_token grant', (asm.grant_types_supported || []).includes('refresh_token'));
  check('as-metadata: token auth method none (public client)', (asm.token_endpoint_auth_methods_supported || []).includes('none'));
  // The Claude Zod gotcha: registration_endpoint must be ABSENT, not null.
  check('as-metadata: registration_endpoint OMITTED', !('registration_endpoint' in asm));

  // 3. Unauthenticated /mcp → 401 + WWW-Authenticate pointer
  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
  });
  const wwwAuth = unauth.headers.get('www-authenticate') || '';
  check('unauth /mcp → 401', unauth.status === 401, `status ${unauth.status}`);
  check('unauth /mcp → WWW-Authenticate resource_metadata', wwwAuth.includes('resource_metadata'), wwwAuth);

  if (!TOKEN) {
    console.log('\n(no MCP_ACCESS_TOKEN set — skipping authenticated ping path)');
    return done();
  }

  // 4. Authenticated: initialize → tools/list → tools/call ping
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '0' } }, 1);
  check('initialize → 200', init.status === 200, `status ${init.status}`);
  check('initialize → serverInfo', !!init.json?.result?.serverInfo, JSON.stringify(init.json?.result?.serverInfo));

  const list = await rpc('tools/list', {}, 2);
  const toolNames = (list.json?.result?.tools || []).map((t) => t.name);
  check('tools/list → includes ping', toolNames.includes('ping'), toolNames.join(', '));

  const ping = await rpc('tools/call', { name: 'ping', arguments: {} }, 3);
  const pingText = ping.json?.result?.content?.[0]?.text || '';
  check('tools/call ping → pong', pingText.includes('pong'), pingText);

  done();
}

function done() {
  const status = failures === 0 ? 'PASS' : `FAIL (${failures})`;
  console.log(`\n${status}`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.error('smoke harness error:', err);
  process.exit(1);
}
