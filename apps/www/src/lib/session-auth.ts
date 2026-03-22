import type { Identity } from '@imajin/auth';

// Comma-separated list of DIDs that have admin access
const ADMIN_DIDS = (process.env.ADMIN_DID || '').split(',').map((d) => d.trim()).filter(Boolean);

/**
 * Check if a DID has admin access.
 * Requires explicit membership in the ADMIN_DID env var list,
 * or an established-tier identity when no explicit list is set.
 */
export function isAdmin(identity: Identity): boolean {
  if (ADMIN_DIDS.length > 0) {
    return ADMIN_DIDS.includes(identity.id);
  }
  return identity.tier === 'established';
}
