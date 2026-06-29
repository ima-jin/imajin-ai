import { db, identities } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { buildAgentActorRow, type PromoteActorInput } from './agent-actor';

const log = createLogger('kernel');

/**
 * Promote-on-authorize (#1170 Stage 0).
 *
 * Mint-or-link the granted app's app_did into a first-class auth.identities
 * actor row (scope=actor, subtype=agent, non-signing sentinel key, NULL handle)
 * when one does not already exist. Generalizes the Claude one-off from migration
 * 0053 (#1178) so EVERY authorized integration becomes a graph actor that
 * listGrantedIntegrations (#1179) can enrich with an agent badge.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` covers both the PK (id == app_did) and the
 * unique sentinel public_key, so it is safe to call on every authorize, including
 * re-consent and apps already promoted by migration 0053.
 *
 * Deliberately a plain INSERT: it MUST NOT emit `identity.created`, which would
 * trigger the MJN-emission / forest reactors (#1171 Correction 2). Agent actors
 * are not economic onboarding events.
 *
 * Non-fatal by contract — the app.authorized attestation is the source of truth
 * for the grant, so a promotion failure is logged and swallowed rather than
 * breaking the authorize flow.
 */
export async function promoteActorOnGrant(input: PromoteActorInput): Promise<void> {
  const row = buildAgentActorRow(input);
  try {
    await db.insert(identities).values(row).onConflictDoNothing();
  } catch (err) {
    log.error(
      { err: String(err), appId: input.appId, appDid: input.appDid },
      'promote-on-authorize: failed to mint actor identity (non-fatal)',
    );
  }
}
