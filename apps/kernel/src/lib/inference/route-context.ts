import type { AppAuthContext, Identity } from '@imajin/auth';
import { connectionCaller, sessionConnectionCaller, type ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';
import type { InferenceAuthContext, InferenceAuthResult } from './auth';

type RouteInput = { app: AppAuthContext } | { identity: Identity } | { caller: ConnectionCaller; appDid?: string };

/** Pure projection of verified identity/selectors. Authority is always rechecked by resolveConnectionPrincipal. */
export function resolveInferenceRouteContext(input: { caller: ConnectionCaller; appDid?: string }): { ok: true; context: InferenceAuthContext };
export function resolveInferenceRouteContext(input: RouteInput): InferenceAuthResult;
export function resolveInferenceRouteContext(input: RouteInput): InferenceAuthResult {
  if ('app' in input) {
    if (!(input.app.actingFor || input.app.userDid)) return {
      ok: false, error: 'App-authenticated inference requires an authenticated caller DID', status: 400,
    };
    return callerContext(connectionCaller(input.app.userDid, input.app), input.app.appDid);
  }
  if ('caller' in input) return callerContext(input.caller, input.appDid);
  const { identity } = input;
  const orgDid = identity.actingAs;
  if (orgDid && identity.actingFor && identity.actingFor !== orgDid && identity.subtype !== 'agent') {
    return { ok: false, error: 'Conflicting acting identity context', status: 403 };
  }
  return callerContext(connectionCaller(identity.id, identity), undefined, Boolean(sessionConnectionCaller(identity).caller));
}

/** Keep owner-only compatibility while preserving verified callers for canonical principal resolution. */
export function inferenceBrainContext(context: InferenceAuthContext): string | InferenceAuthContext {
  return context.appDid || context.orgContext || context.caller ? context : context.ownerDid;
}

function callerContext(caller: ConnectionCaller, appDid?: string, includeCaller = true): { ok: true; context: InferenceAuthContext } {
  const memberDid = caller.actingFor ?? caller.actorDid;
  const orgDid = caller.actingAs;
  return { ok: true, context: {
    ownerDid: orgDid ?? memberDid,
    ...(includeCaller ? { caller: connectionCaller(caller.actorDid, caller) } : {}),
    ...(appDid ? { appDid } : {}),
    ...(orgDid && orgDid !== memberDid ? { orgContext: { memberDid, orgDid } } : {}),
  } };
}
