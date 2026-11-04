import { ExternalMcpError } from './external-mcp-policy';
import type { Identity } from '@imajin/auth';

/** Authenticated signer plus verified selectors, never a body-selected owner. */
export interface ConnectionCaller {
  actorDid: string;
  actingFor?: string;
  actingAs?: string;
}
export function connectionCaller(actorDid: string, selectors: Pick<ConnectionCaller, 'actingAs' | 'actingFor'>): ConnectionCaller {
  return {
    actorDid,
    ...(selectors.actingAs ? { actingAs: selectors.actingAs } : {}),
    ...(selectors.actingFor ? { actingFor: selectors.actingFor } : {}),
  };
}
export function sessionConnectionCaller(identity: Identity): { caller?: ConnectionCaller } {
  if (!identity.actingAs && !identity.actingFor && identity.subtype !== 'agent') return {};
  return { caller: connectionCaller(identity.id, identity) };
}
export const callerArguments = (caller?: ConnectionCaller): [ConnectionCaller] | [] => caller ? [caller] : [];
/** Eligibility for assignment checks only; subtype never grants authority. */
export const isAgentCapableSubtype = (subtype: string | null) => subtype === 'agent' || subtype === 'presence';
export const missingConnection = (did: string) => new ExternalMcpError(
  403, `No active connection for ${did}. Configure that identity's connectors on /auth/connectors while acting as ${did}`,
  'connection_not_loaded',
);
export const isOrgScope = (scope: string) => ['business', 'community', 'family'].includes(scope);
