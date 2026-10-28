import { eq, sql } from 'drizzle-orm';
import { db, attestations, registryApps } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { auditMemberConnection, authorizeExternalMcp } from './external-mcp';
import { ExternalMcpError } from './external-mcp-policy';
import { forwardAppUpstream } from './external-mcp-transport';
import { reserveExternalMcpCall } from './external-mcp-limits';
import {
  connectionUnavailable, findMemberConnection, requireConnectionApp, type ExternalMcpCaller,
} from './member-connection-gate';
import {
  assertDeclaredCall, parseUpstream, upstreamBinding, upstreamCallInput, upstreamDeclarations,
  upstreamProvider, UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE, type AppUpstream,
} from './app-upstream-policy';

export async function declareAppUpstreams(appDid: string, raw: unknown) {
  const { upstreams } = parseUpstream(upstreamDeclarations, raw);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app-upstreams:${appDid}`}, 0))`);
    const app = await requireConnectionApp(tx, appDid, UPSTREAM_READ_SCOPE, true);
    await tx.update(registryApps).set({ upstreams, updatedAt: new Date() }).where(eq(registryApps.id, app.id));
    await tx.insert(attestations).values(await prepareMechanicalAttestation({
      subjectDid: appDid, type: 'connector.external-mcp', contextId: appDid, contextType: 'app-upstreams',
      payload: { action: 'upstreams-declared', appDid, previous: app.upstreams, upstreams },
    }));
    return { upstreams };
  });
}
export async function resolveAppUpstream(appDid: string, upstreamId: string): Promise<AppUpstream> {
  const app = await requireConnectionApp(db, appDid, UPSTREAM_READ_SCOPE, true);
  const { upstreams } = parseUpstream(upstreamDeclarations, { upstreams: app.upstreams });
  const target = upstreams.find(item => item.id === upstreamId);
  if (!target) throw new ExternalMcpError(403, 'Upstream not declared');
  return target;
}
export function appConnectionTarget(appDid: string, target: AppUpstream, scope = UPSTREAM_READ_SCOPE) {
  return { provider: upstreamProvider(appDid, target.id), binding: upstreamBinding(appDid, target), scope };
}
/** Authenticated app DID is supplied by requireAppAuth, never by the request body. */
export async function invokeAppUpstream(caller: ExternalMcpCaller & { scopes?: readonly string[] }, raw: unknown) {
  const call = parseUpstream(upstreamCallInput, raw);
  if (!caller.appDid || !caller.serviceToken || caller.memberDid !== call.memberDid) throw connectionUnavailable();
  const appDid = caller.appDid;
  const provider = upstreamProvider(appDid, call.upstreamId);
  const row = await findMemberConnection(db, caller.memberDid, provider);
  let outcome = 'refused';
  let release: (() => void) | undefined;
  try {
    release = reserveExternalMcpCall(caller.memberDid, appDid);
    const target = await resolveAppUpstream(appDid, call.upstreamId);
    assertDeclaredCall(target, call);
    const scope = ['GET', 'HEAD'].includes(call.method) ? UPSTREAM_READ_SCOPE : UPSTREAM_WRITE_SCOPE;
    if (!caller.scopes?.includes(scope)) throw connectionUnavailable();
    const context = await authorizeExternalMcp(caller, appConnectionTarget(appDid, target, scope));
    try {
      const value = await forwardAppUpstream(target, call, context.credential);
      outcome = 'returned';
      return value;
    } catch {
      outcome = 'upstream-failed';
      throw new ExternalMcpError(502, 'External MCP upstream unavailable');
    } finally { context.credential = ''; }
  } finally {
    release?.();
    // Metadata only: not path/body/query/header/provider output, and no raw reason text.
    await db.transaction(tx => auditMemberConnection(tx, caller.memberDid, row?.orgContextDid ?? null, 'call', {
      appDid, upstreamId: call.upstreamId, method: call.method, reason: call.reason ?? null, outcome,
    }, provider));
  }
}
