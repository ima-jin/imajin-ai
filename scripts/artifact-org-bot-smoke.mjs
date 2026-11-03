import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const KERNEL = 'https://jin.imajin.ai';
const PASSTHROUGH = 'http://127.0.0.1:8787';
const DID = /^did:[a-z0-9]+:[^\s]+$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const failure = () => new Error('Org bot smoke failed');

function validateInput(input) {
  if (!input || !DID.test(input.agentDid) || !DID.test(input.orgDid)
    || typeof input.model !== 'string' || !input.model.trim()
    || typeof input.auditToken !== 'string' || !input.auditToken.trim()
    || typeof input.agentToken !== 'string') throw failure();
  const [header, payload, signature, extra] = input.agentToken.split('.');
  if (!header || !payload || !signature || extra) throw failure();
  const type = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  // Shape checks never authorize; the kernel verifies this token and live assignment.
  if (type.typ !== 'app+jwt' || type.alg !== 'EdDSA' || claims.azp !== input.agentDid
    || claims.sub !== input.agentDid || claims.aud !== 'imajin:apps'
    || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw failure();
}

async function jsonRequest(fetcher, url, init) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw failure();
  return response.json();
}

/** Anthropic lane only. Warp must not be added until #2278 and #3203 are on main. */
export async function runAnthropicSmoke(input, {
  dryRun = false, fetcher = globalThis.fetch, sleep = delay,
} = {}) {
  if (dryRun) return { status: 'dry-run', billedOrg: null, usageIds: [] };
  validateInput(input);
  const headers = { Authorization: `Bearer ${input.agentToken}`, 'x-acting-as': input.orgDid };
  const query = new URLSearchParams({ explain: '1', model: input.model });
  const discovery = await jsonRequest(fetcher, `${KERNEL}/infer/v1/models/usable?${query}`, { headers });
  const route = discovery.routes?.find(row => row.kind === 'A' && row.usable === true
    && row.billedPrincipal?.did === input.orgDid && row.billedPrincipal?.handle === 'artifact'
    && row.card?.provider === 'anthropic' && row.selectors?.actingAs === input.orgDid
    && !row.selectors?.actingFor && row.selectedModels?.includes(input.model));
  if (!route) throw failure();
  const session = randomUUID();
  const completion = await jsonRequest(fetcher, `${PASSTHROUGH}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      'x-imajin-session': session, 'x-imajin-turn': session },
    body: JSON.stringify({
      model: input.model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply OK.' }],
    }),
  });
  if (typeof completion.id !== 'string') throw failure();
  for (let attempt = 0; attempt < 5; attempt++) {
    const audit = await jsonRequest(fetcher, `${KERNEL}/usage/api/audit/sessions/${session}`, {
      headers: { Authorization: `Bearer ${input.auditToken}`, 'x-acting-as': input.orgDid },
    });
    if (audit.principalDid !== input.orgDid) throw failure();
    const rows = audit.turns?.flatMap(turn => turn.usage) ?? [];
    const matching = rows.filter(row => row.source === 'inference-passthrough'
      && row.provider === 'anthropic' && row.agentDid === input.agentDid
      && row.externalId === completion.id && row.status !== 'error');
    if (matching.length > 0 && matching.every(row => typeof row.id === 'string' && SAFE_ID.test(row.id))) {
      return { status: 'passed', billedOrg: 'artifact', usageIds: matching.map(row => row.id) };
    }
    await sleep(1000);
  }
  throw failure();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const dryRun = process.argv.includes('--dry-run');
    const result = await runAnthropicSmoke(dryRun ? undefined : JSON.parse(readFileSync(0, 'utf8')), { dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Never print exceptions, credentials, URLs, response bodies or prompts.
    process.stdout.write(`${JSON.stringify({ status: 'failed', billedOrg: null, usageIds: [] })}\n`);
    process.exitCode = 1;
  }
}
