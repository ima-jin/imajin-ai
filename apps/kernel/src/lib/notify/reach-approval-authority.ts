import type { Identity } from '@imajin/auth';
import { getClient } from '@imajin/db';
import type { ReachBlockReader } from '../auth/reach-block';

/** Cookie/role hints alone never authorize a write; recheck live membership. */
export async function reachActAsPrincipal(identity: Identity, reader: ReachBlockReader = getClient()): Promise<string | null> {
  if (identity.scope !== 'actor' || identity.subtype !== 'human' || identity.actingFor || !identity.actingAs) return null;
  const rows = await reader.unsafe(`
    SELECT 1 FROM auth.identity_members
    WHERE identity_did = $1 AND member_did = $2
      AND role IN ('owner', 'admin') AND removed_at IS NULL
      AND (allowed_services IS NULL OR 'jin' = ANY(allowed_services))
    LIMIT 1 FOR SHARE
  `, [identity.actingAs, identity.id]);
  return rows.length ? identity.actingAs : null;
}

export async function canDecideReach(identity: Identity, principalDid: string, reader?: ReachBlockReader): Promise<boolean> {
  if (identity.scope !== 'actor' || identity.subtype !== 'human' || identity.actingFor) return false;
  if (!identity.actingAs) return identity.id === principalDid;
  return await reachActAsPrincipal(identity, reader) === principalDid;
}
