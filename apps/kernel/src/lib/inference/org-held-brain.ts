import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, connectors, vaultDelegationGrants } from '@/src/db';
import { _applyDelegationGrant, vaultService } from '@/src/lib/vault';
import { isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity, getNodeXPrivateKey } from '@/src/lib/vault/sealing';
import { requireOrgConnectionMemberGrant } from '@/src/lib/kernel/org-connection-member-grants';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { authorizeMemberConnection, isLiveConnection } from '@/src/lib/kernel/member-connection-gate';
import type { VerifiedInferenceOrgContext } from './auth';
import type { ResolvedBrain } from './brain';
import { missingConnection } from '@/src/lib/kernel/connection-principal';
import { isOrgSealedAnthropicField } from '@/src/lib/kernel/org-held-connection-policy';

const unavailable = () => new ExternalMcpError(503, 'Organization inference credential unavailable', 'credential_unavailable');

/** One live grant + custody snapshot per call; never cache a key or authorization. */
export function resolveOrgHeldBrain(context: VerifiedInferenceOrgContext, modelId = ''): Promise<ResolvedBrain> {
  return db.transaction(async tx => {
    const { memberDid, orgDid } = context;
    const lock = `org-held-connection:${orgDid}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const assignedConnection = context.assignedAgentDid ? await authorizeMemberConnection(tx, {
      memberDid: context.assignedAgentDid, caller: { actorDid: context.assignedAgentDid, actingAs: orgDid },
    }, { provider: 'anthropic', scope: 'infer:completions', service: 'infer' }) : undefined;
    const grant = context.assignedAgentDid ? undefined : await requireOrgConnectionMemberGrant({
      memberDid, orgDid, actingDid: orgDid, provider: 'anthropic',
    }, tx);
    // Grant errors stay outside the custody catch: preserve their clear 403.
    try {
      const row = assignedConnection ?? (await tx.select().from(connectors).where(and(
        ...(grant ? [eq(connectors.id, grant.connectionId)] : []), eq(connectors.ownerDid, orgDid),
        eq(connectors.provider, 'anthropic'), eq(connectors.slot, 'primary'),
      )).limit(1))[0];
      if (!row || !isLiveConnection(row) || !row.sealedKeyField
        || !(isExternalMcpField(row.sealedKeyField) || isOrgSealedAnthropicField(orgDid, row.sealedKeyField))) throw missingConnection(orgDid);
      const node = getNodeSigningIdentity();
      const [custody] = await tx.select().from(vaultDelegationGrants).where(and(
        eq(vaultDelegationGrants.field, row.sealedKeyField), inArray(vaultDelegationGrants.subject, [orgDid, node.senderDid]),
        eq(vaultDelegationGrants.grantedTo, node.senderDid), eq(vaultDelegationGrants.status, 'active'),
      )).limit(1).for('update');
      if (!custody || !isLiveConnection(custody) || custody.oneTime) throw unavailable();
      const entry = await vaultService.get(row.sealedKeyField);
      if (!entry || entry.deleted || entry.senderPubkey !== node.senderPubkey || entry.custodyScheme !== 'delegation-grant') {
        throw unavailable();
      }
      const apiKey = await _applyDelegationGrant(entry, custody, getNodeXPrivateKey(), node.senderPubkey);
      if (!apiKey || !isLiveConnection(custody)) throw unavailable();
      return {
        connector: 'anthropic', provider: 'anthropic', credentialDid: orgDid, modelId, apiKey,
        ...(context.assignedAgentDid ? { actorDid: context.assignedAgentDid } : {}),
        orgUsage: {
          memberDid: context.assignedAgentDid ? orgDid : memberDid, orgDid,
          ...(grant ? { grantId: grant.grantId } : {}), connectionId: row.id,
        },
      };
    } catch (error) {
      if (error instanceof ExternalMcpError && error.status === 403) throw error;
      // Vault failures may contain field/value material. Never propagate it.
      throw unavailable();
    }
  });
}
