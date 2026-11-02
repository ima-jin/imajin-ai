import { and, eq, sql } from 'drizzle-orm';
import { db, connectors, vaultDelegationGrants } from '@/src/db';
import { _applyDelegationGrant, vaultService } from '@/src/lib/vault';
import { isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { getNodeSigningIdentity, getNodeXPrivateKey } from '@/src/lib/vault/sealing';
import { requireOrgConnectionMemberGrant } from '@/src/lib/kernel/org-connection-member-grants';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import { isLiveConnection } from '@/src/lib/kernel/member-connection-gate';
import type { VerifiedInferenceOrgContext } from './auth';
import type { ResolvedBrain } from './brain';

const unavailable = () => new ExternalMcpError(503, 'Organization inference credential unavailable');

/** One live grant + custody snapshot per call; never cache a key or authorization. */
export function resolveOrgHeldBrain(context: VerifiedInferenceOrgContext, modelId = ''): Promise<ResolvedBrain> {
  return db.transaction(async tx => {
    const { memberDid, orgDid } = context;
    const lock = `org-held-connection:${orgDid}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const grant = await requireOrgConnectionMemberGrant({
      memberDid, orgDid, actingDid: orgDid, provider: 'anthropic',
    }, tx);
    // Grant errors stay outside the custody catch: preserve their clear 403.
    try {
      const [row] = await tx.select().from(connectors).where(and(
        eq(connectors.id, grant.connectionId), eq(connectors.ownerDid, orgDid),
        eq(connectors.provider, 'org-held-anthropic'), eq(connectors.slot, 'primary'),
      )).limit(1);
      if (!row || !isLiveConnection(row) || !row.sealedKeyField || !isExternalMcpField(row.sealedKeyField)) throw unavailable();
      const node = getNodeSigningIdentity();
      const [custody] = await tx.select().from(vaultDelegationGrants).where(and(
        eq(vaultDelegationGrants.field, row.sealedKeyField), eq(vaultDelegationGrants.subject, orgDid),
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
        orgUsage: { memberDid, orgDid, grantId: grant.grantId, connectionId: grant.connectionId },
      };
    } catch {
      // Vault failures may contain field/value material. Never propagate it.
      throw unavailable();
    }
  });
}
