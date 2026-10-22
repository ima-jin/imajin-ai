import { GRANT_DEFAULT_TTL, GRANT_MAX_TTL } from '@imajin/auth/grant-scopes';

/** Renewal events anchor the current lease without rewriting the original issue date. */
export function previousGrantLeaseMs(grant: {
  issuedAt: string;
  expiresAt: string;
  history: { event: string; createdAt: string }[];
}): number {
  const start = grant.history
    .filter(entry => entry.event === 'renewed')
    .reduce((latest, entry) => Math.max(latest, Date.parse(entry.createdAt)), Date.parse(grant.issuedAt));
  const ttl = Date.parse(grant.expiresAt) - start;
  return Math.min(Number.isFinite(ttl) && ttl > 0 ? ttl : GRANT_DEFAULT_TTL, GRANT_MAX_TTL);
}

export function operatorGrantExpiryWarning(grant: {
  status: string;
  expiresAt: string;
  capabilities: string[];
}, now = Date.now()): string | null {
  const remaining = Date.parse(grant.expiresAt) - now;
  if (grant.status === 'revoked' || !grant.capabilities.includes('operator:approvals') || !Number.isFinite(remaining) || remaining <= 0 || remaining > GRANT_DEFAULT_TTL) return null;
  return `Operator approvals expires in ${Math.ceil(remaining / (60 * 60 * 1000))}h — renew to keep approvals working.`;
}
