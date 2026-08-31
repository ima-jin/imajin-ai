import type { GrantScope } from './grant-scopes';

export type DelegationAudience =
  | { type: 'all' }
  | { type: 'dids'; values: string[] };

export interface CapabilityRevocation {
  capability: GrantScope;
  revokedAt: string;
}

export interface DelegationGrant {
  grantId: string;
  agentDid: string;
  delegatorDid: string;
  capabilities: GrantScope[];
  audience: DelegationAudience;
  expiry: string;
  issuedAt: string;
  revokedAt: string | null;
  capabilityRevocations: CapabilityRevocation[];
  onBehalfOf: string[];
}

export interface DelegationProvenance {
  delegatorDid: string;
  agentDid: string;
  grantId: string;
}

/** Deliberately accepts every DID method; only patterns and non-DIDs are rejected. */
export function isDid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) &&
    !value.includes('*');
}

export function isDelegationAudience(value: unknown): value is DelegationAudience {
  if (!value || typeof value !== 'object') return false;
  const audience = value as Record<string, unknown>;
  if (audience.type === 'all') return Object.keys(audience).length === 1;
  if (audience.type !== 'dids' || !Array.isArray(audience.values)) return false;
  return audience.values.length > 0 &&
    new Set(audience.values).size === audience.values.length &&
    audience.values.every(isDid);
}

export function audienceAllows(audience: DelegationAudience, targetDid?: string): boolean {
  if (audience.type === 'all') return true;
  return typeof targetDid === 'string' && audience.values.includes(targetDid);
}

/**
 * Optional chain of DIDs the delegator is itself accountable to (e.g. a group
 * admin issuing a grant on behalf of the group DID). `delegatorDid` and
 * `agentDid` are recorded on the grant separately and must not be repeated
 * here — the chain names authority *above* the delegator, nothing else.
 */
export function isOnBehalfOfChain(value: unknown, delegatorDid: string, agentDid: string): value is string[] {
  if (!Array.isArray(value)) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every((did) => isDid(did) && did !== delegatorDid && did !== agentDid);
}

export function grantProvenance(grant: Pick<DelegationGrant, 'delegatorDid' | 'agentDid' | 'grantId'>): DelegationProvenance {
  return {
    delegatorDid: grant.delegatorDid,
    agentDid: grant.agentDid,
    grantId: grant.grantId,
  };
}
