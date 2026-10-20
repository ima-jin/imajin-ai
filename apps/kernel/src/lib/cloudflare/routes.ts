import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { authenticateCloudflare, authorizeZone, type ZoneAuthority } from './authority';
import { CloudflareError, domainSchema, hostnameSchema, parse } from './schemas';
import {
  createDns, patchDns, deleteDns, listDns, zoneSettings, cacheRules,
  createHostname, deleteHostname, hostname,
} from './operations';
import { bulkProxy, setCache } from './approvals';
import { history } from './audit';
import { classificationReport } from './classification';

type Params = { zoneId: string; recordId?: string; hostnameId?: string };
type HandlerContext = { params: Promise<Params> };
type Operation = (authority: ZoneAuthority, body: Record<string, unknown>, params: Params) => Promise<unknown>;
interface Action { capability: string; operation: Operation; envelope?: string; body?: boolean; status?: number }

const actions = {
  classification: { capability: 'cloudflare:read', envelope: 'classification', operation: classificationReport },
  listDns: { capability: 'cloudflare:read', envelope: 'records', operation: listDns },
  createDns: { capability: 'cloudflare:dns', envelope: 'record', body: true, status: 201,
    operation: (a, body) => createDns(a, withoutDomain(body)) },
  patchDns: { capability: 'cloudflare:dns', envelope: 'record', body: true,
    operation: (a, body, params) => patchDns(a, params.recordId!, withoutDomain(body)) },
  deleteDns: { capability: 'cloudflare:dns', envelope: 'record',
    operation: (a, _body, params) => deleteDns(a, params.recordId!) },
  settings: { capability: 'cloudflare:read', envelope: 'settings', operation: zoneSettings },
  ssl: { capability: 'cloudflare:ssl', envelope: 'ssl',
    operation: async a => (await zoneSettings(a)).find(setting => setting.id === 'ssl') ?? null },
  cacheRules: { capability: 'cloudflare:read', envelope: 'rules', operation: cacheRules },
  setCache: { capability: 'cloudflare:cache', body: true, operation: setCache },
  listHostnames: { capability: 'cloudflare:read', envelope: 'hostnames',
    operation: a => a.client.list('/custom_hostnames', hostnameSchema) },
  createHostname: { capability: 'cloudflare:custom-hostnames', envelope: 'hostname', body: true, status: 201,
    operation: (a, body) => createHostname(a, withoutDomain(body)) },
  hostname: { capability: 'cloudflare:read', envelope: 'hostname',
    operation: (a, _body, params) => hostname(a, params.hostnameId!) },
  deleteHostname: { capability: 'cloudflare:custom-hostnames', envelope: 'hostname',
    operation: (a, _body, params) => deleteHostname(a, params.hostnameId!) },
  bulk: { capability: 'cloudflare:dns', body: true, operation: bulkProxy },
  history: { capability: 'cloudflare:read', envelope: 'history', operation: history },
} satisfies Record<string, Action>;

function withoutDomain(body: Record<string, unknown>) {
  const result = { ...body };
  delete result.domain;
  return result;
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > 32_768) throw new CloudflareError(413, 'request_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new CloudflareError(400, 'invalid_request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) return reader.cancel().then(() => { throw new CloudflareError(413, 'request_too_large'); });
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid');
    return body as Record<string, unknown>;
  } catch {
    throw new CloudflareError(400, 'invalid_request');
  }
}

/** A single guarded seam keeps provider and vault exceptions off every response. */
export function cloudflareRoute(name: keyof typeof actions) {
  const action: Action = actions[name];
  return async (request: NextRequest, context: HandlerContext) => {
    const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
    try {
      const params = await context.params;
      const actor = await authenticateCloudflare(request, action.capability);
      const body = action.body ? await readBody(request) : {};
      const queryDomain = request.nextUrl.searchParams.get('domain');
      const domain = parse(domainSchema, queryDomain ?? body.domain);
      if (body.domain !== undefined && body.domain !== domain) throw new CloudflareError(403, 'domain_mismatch');
      if (action.body) body.domain = domain;
      const authority = await authorizeZone(actor, params.zoneId, domain, action.capability);
      const result = await action.operation(authority, body, params);
      const response = action.envelope ? { [action.envelope]: result } : result;
      const pending = result && typeof result === 'object' && 'approval' in result;
      return NextResponse.json(response, { status: pending ? 202 : action.status ?? 200, headers });
    } catch (error) {
      const known = error instanceof CloudflareError;
      return NextResponse.json({ error: known ? error.code : 'cloudflare_operation_unavailable' },
        { status: known ? error.status : 503, headers });
    }
  };
}
