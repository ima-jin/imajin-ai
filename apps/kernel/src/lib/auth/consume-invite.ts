import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, invitesInConnections as invites, podsInConnections as pods, podMembersInConnections as podMembers, connections, profiles } from '@/src/db';
import { eq, and, or } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { checkPreliminaryEligibility, checkHardEligibility } from '@/src/lib/kernel/verification';

const log = createLogger('kernel');

/**
 * Auto-consume pending invites for a newly created/verified identity.
 * Matches by email or DID. Creates connection pod + marks invite accepted.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function consumePendingInvites(opts: {
  did: string;
  email: string;
  handle?: string | null;
}): Promise<void> {
  const { did, email, handle } = opts;
  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Find pending invites sent to this email or DID
    const pendingInvites = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.status, 'pending'),
          or(
            eq(invites.toEmail, normalizedEmail),
            eq(invites.toDid, did),
          ),
        ),
      );

    if (pendingInvites.length === 0) return;

    for (const invite of pendingInvites) {
      // Skip self-invites
      if (invite.fromDid === did) continue;

      // Skip expired invites
      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) continue;

      // Skip fully used invites
      if (invite.usedCount >= invite.maxUses) continue;

      try {
        // Create connection pod
        const podId = generateId('pod_');
        const senderLabel = invite.fromHandle || invite.fromDid.slice(0, 16);
        const accepterLabel = handle || did.slice(0, 16);

        await db.insert(pods).values({
          id: podId,
          name: `${senderLabel} ↔ ${accepterLabel}`,
          ownerDid: invite.fromDid,
          type: 'personal',
          visibility: 'private',
        });

        await db.insert(podMembers).values([
          { podId, did: invite.fromDid, role: 'member', addedBy: invite.fromDid },
          { podId, did, role: 'member', addedBy: did },
        ]);

        // Create or reconnect connection
        const [connDidA, connDidB] = [invite.fromDid, did].sort((a, b) => a.localeCompare(b));
        await db.insert(connections).values({ didA: connDidA, didB: connDidB })
          .onConflictDoUpdate({
            target: [connections.didA, connections.didB],
            set: { disconnectedAt: null, connectedAt: new Date() },
          });

        // Mark invite as accepted
        const now = new Date().toISOString();
        await db
          .update(invites)
          .set({
            status: 'accepted',
            acceptedAt: now,
            usedCount: invite.usedCount + 1,
            consumedBy: did,
            toDid: did,
          })
          .where(eq(invites.id, invite.id));

        // Emit bus events for attestation + MJN
        const [inviterProfile] = await db
          .select()
          .from(profiles)
          .where(eq(profiles.did, invite.fromDid))
          .limit(1);

        publish('connection.accepted', {
          issuer: did,
          subject: invite.fromDid,
          scope: 'connections',
          payload: {
            invite_code: invite.code,
            context_id: podId,
            context_type: 'connection',
            name: handle || did.slice(0, 16),
            email: inviterProfile?.contactEmail || undefined,
          },
        }).catch((err: unknown) => log.error({ err: String(err) }, '[consume-invite] connection.accepted error'));

        publish('vouch', {
          issuer: invite.fromDid,
          subject: did,
          scope: 'connections',
          payload: {
            invite_code: invite.code,
            context_id: podId,
            context_type: 'connection',
          },
        }).catch((err: unknown) => log.error({ err: String(err) }, '[consume-invite] vouch error'));

        // Check verification eligibility — fire and forget
        checkPreliminaryEligibility(invite.fromDid).catch(() => {});
        checkPreliminaryEligibility(did).catch(() => {});
        checkHardEligibility(invite.fromDid).catch(() => {});
        checkHardEligibility(did).catch(() => {});

        log.info({ inviteId: invite.id, fromDid: invite.fromDid, toDid: did }, '[consume-invite] Invite auto-consumed');
      } catch (err) {
        log.error({ err: String(err), inviteId: invite.id }, '[consume-invite] Failed to consume invite');
      }
    }
  } catch (err) {
    log.error({ err: String(err), did }, '[consume-invite] Error looking up pending invites');
  }
}
