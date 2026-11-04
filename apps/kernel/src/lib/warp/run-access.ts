import { getClient } from '@imajin/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { isOrgScope, type ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';
import { WarpRunAccessError } from './errors';

const SYSTEM_CALLER = Symbol('warp-receipt-system-caller');
const MAX_LINEAGE_DEPTH = 64;
type RunCaller = ConnectionCaller & { [SYSTEM_CALLER]?: true };

export interface WarpRunReceipt {
  principalDid: string;
  actorDid?: string;
  orgDid?: string;
  parentRunId: string | null;
}

/** Reuse connection-principal resolution, including assigned org bots. */
export async function dispatchRunAttribution(principalDid: string, caller?: ConnectionCaller) {
  if (caller) {
    const { resolveConnectionPrincipal } = await import('@/src/lib/kernel/connection-principal');
    const principal = await resolveConnectionPrincipal(caller, 'warp');
    if (principal.ownerDid !== principalDid) throw new WarpRunAccessError();
    return { actorDid: caller.actorDid, ...(principal.orgContext ? { orgDid: principal.orgContext.orgDid } : {}) };
  }
  const { lookupIdentity } = await import('@/src/lib/kernel/lookup');
  const identity = await lookupIdentity(principalDid);
  return { actorDid: principalDid, ...(identity && isOrgScope(identity.scope) ? { orgDid: principalDid } : {}) };
}

/** Only trusted kernel jobs construct this capability; it cannot arrive over HTTP/MCP. */
export function nodeRunCaller(): ConnectionCaller {
  return { actorDid: getNodeSigningIdentity().senderDid, [SYSTEM_CALLER]: true } as RunCaller;
}

function isSystemCaller(caller?: ConnectionCaller): boolean {
  return (caller as RunCaller | undefined)?.[SYSTEM_CALLER] === true
    && caller?.actorDid === getNodeSigningIdentity().senderDid;
}

/** Only after receipt authorization may a system job unwrap the recorded principal's key. */
export function runCredentialCaller(caller?: ConnectionCaller): ConnectionCaller | undefined {
  return isSystemCaller(caller) ? undefined : caller;
}

/**
 * Read the ORIGINAL node-witnessed dispatch, never a later resume/actor assertion.
 * Raw run IDs are the existing loop IDs. signed-loop:* is assigned by signed
 * ingest; legacy direct bus observations have random IDs and are not authority.
 * Bind lineage to both the dispatch and projection so a later loop publisher
 * cannot graft their run onto somebody else's ancestor.
 */
export async function readRunReceipt(runId: string): Promise<WarpRunReceipt | null> {
  const sql = getClient();
  const rows = await sql`
    SELECT l.principal, l.parent_loop_id, e.payload
    FROM kernel.loops l
    INNER JOIN LATERAL (
      SELECT e.payload FROM kernel.loop_events e
      WHERE e.loop_id = l.loop_id AND e.principal = l.principal
        AND e.issuer = ${getNodeSigningIdentity().senderDid}
        AND e.id ~ '^signed-loop:[0-9a-f]{64}$'
        AND e.type = 'loop.started'
        AND e.payload->>'kind' = 'warp.run'
        AND e.payload->>'loopId' = l.loop_id
        AND e.payload->>'principal' = l.principal
        AND e.payload->'refs'->>'runId' = l.loop_id
      ORDER BY e.occurred_at, e.id LIMIT 1
    ) e ON TRUE
    WHERE l.loop_id = ${runId} AND l.kind = 'warp.run'
  `;
  const row = rows[0];
  if (!row || typeof row.principal !== 'string') return null;
  const payload = row.payload as Record<string, unknown>;
  const parentRunId = typeof payload.parentLoopId === 'string' ? payload.parentLoopId : null;
  if (parentRunId !== row.parent_loop_id) return null;
  return {
    principalDid: row.principal,
    ...(typeof payload.actorDid === 'string' ? { actorDid: payload.actorDid } : {}),
    ...(typeof payload.orgDid === 'string' ? { orgDid: payload.orgDid } : {}),
    parentRunId,
  };
}

/** actorDid is authenticated separately from the credential/acting-as principal. */
function owns(callerDid: string, receipt: WarpRunReceipt): boolean {
  return callerDid === receipt.principalDid || callerDid === receipt.actorDid;
}

async function readAncestor(runId: string, seen: Set<string>): Promise<WarpRunReceipt> {
  if (seen.has(runId)) throw new WarpRunAccessError();
  seen.add(runId);
  const receipt = await readRunReceipt(runId);
  if (!receipt) throw new WarpRunAccessError();
  return receipt;
}

/**
 * One fail-closed boundary for every HTTP/MCP operation and internal observer.
 * No caller means the explicitly supplied personal principal, NEVER a system
 * bypass. An org-key member is checked as its actor, not promoted to the org.
 */
export async function assertRunAccess(
  principalDid: string,
  runId: string,
  caller?: ConnectionCaller,
  ancestorRunId?: string,
): Promise<WarpRunReceipt> {
  const receipt = await readRunReceipt(runId);
  if (!receipt) throw new WarpRunAccessError();
  const callerDid = caller?.actorDid ?? principalDid;
  const system = isSystemCaller(caller);
  let allowed = system ? receipt.principalDid === principalDid : owns(callerDid, receipt);
  let descendant = ancestorRunId === undefined;
  if (allowed && descendant) return receipt;
  let parent = receipt.parentRunId;
  const seen = new Set([runId]);
  for (let depth = 0; parent && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const ancestor = await readAncestor(parent, seen);
    if (!system && owns(callerDid, ancestor)) allowed = true;
    if (parent === ancestorRunId) descendant = true;
    if (allowed && descendant) return receipt;
    parent = ancestor.parentRunId;
  }
  throw new WarpRunAccessError();
}

export async function canAccessRun(
  principalDid: string, runId: string, caller?: ConnectionCaller, ancestorRunId?: string,
): Promise<boolean> {
  try {
    await assertRunAccess(principalDid, runId, caller, ancestorRunId);
    return true;
  } catch (error) {
    if (error instanceof WarpRunAccessError) return false;
    throw error;
  }
}
