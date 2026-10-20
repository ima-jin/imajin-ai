import { requireAuth, type AuthResult, type AuthError } from '@imajin/auth';

/**
 * Grant management is a principal action, never delegated agent authority.
 * `auth` is the member-service name for this surface (#2954/#2997).
 * Keep identity.id intact: actingAs is the delegator, not the audit actor.
 */
export async function requireGrantPrincipal(request: Request): Promise<AuthResult | AuthError> {
  const result = await requireAuth(request, { service: 'auth' });
  if ('error' in result) return result;
  const { identity } = result;
  if (identity.actingFor || identity.subtype === 'agent' || identity.actingAsRole === 'agent') {
    return { error: 'Grants must be managed by the delegator principal directly, not while acting under agent delegation', status: 403 };
  }
  if (identity.actingAs && !['owner', 'admin'].includes(identity.actingAsRole ?? '')) {
    return { error: 'Only an owner or admin may manage grants as the org', status: 403 };
  }
  return result;
}
