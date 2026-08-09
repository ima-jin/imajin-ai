import { db, identities, identityMembers } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { buildAgentActorRow, buildAgentMembershipRows, type PromoteActorInput } from './agent-actor';

const log = createLogger('kernel');

/**
 * Promote-on-authorize (#1170 Stage 0).
 *
 * Mint-or-link the granted app's app_did into a first-class auth.identities
 * actor row (scope=actor, subtype=agent, real Ed25519 public key, NULL handle)
 * when one does not already exist, and link it to the granting DID via the two
 * `identity_members` rows built by `buildAgentMembershipRows` (#1735). Without
 * those rows the promoted actor is an orphan: it exists but belongs to nobody,
 * and can never be listed under (or act on behalf of) the DID that granted it.
 * Generalizes the Claude one-off from migration 0053 (#1178) so EVERY
 * authorized integration becomes a graph actor that listGrantedIntegrations
 * (#1179) can enrich with an agent badge.
 *
 * Atomic + idempotent: everything happens in one transaction, and every insert
 * is a no-op when the row already exists (`ON CONFLICT DO NOTHING` on the
 * identities PK; an existence check on identity_members, which has no unique
 * constraint on (identity_did, member_did) to target). Safe to call on every
 * authorize, including re-consent and apps already promoted by migration 0053.
 *
 * Deliberately plain INSERTs: this MUST NOT emit `identity.created`, which
 * would trigger the MJN-emission / forest reactors (#1171 Correction 2). Agent
 * actors are not economic onboarding events.
 *
 * Non-fatal by contract — the app.authorized attestation is the source of truth
 * for the grant, so a promotion failure is logged and swallowed rather than
 * breaking the authorize flow.
 */
export async function promoteActorOnGrant(input: PromoteActorInput): Promise<void> {
  const row = buildAgentActorRow(input);
  const membershipRows = buildAgentMembershipRows(input);

  try {
    await db.transaction(async (tx) => {
      await tx.insert(identities).values(row).onConflictDoNothing();

      for (const membership of membershipRows) {
        const existing = await tx
          .select({ identityDid: identityMembers.identityDid })
          .from(identityMembers)
          .where(
            and(
              eq(identityMembers.identityDid, membership.identityDid),
              eq(identityMembers.memberDid, membership.memberDid),
            ),
          )
          .limit(1);

        if (existing.length === 0) {
          await tx.insert(identityMembers).values(membership);
        }
      }
    });
  } catch (err) {
    log.error(
      { err: String(err), appId: input.appId, appDid: input.appDid, ownerDid: input.ownerDid },
      'promote-on-authorize: failed to mint actor identity (non-fatal)',
    );
  }
}
