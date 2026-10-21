import { createHash } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import { GRANT_DEFAULT_TTL } from '@imajin/auth';
import { db, delegationGrants, delegationGrantCapabilities, notifications, preferences } from '@/src/db';
import { operatorGrantExpiryWarning } from '@/src/lib/auth/grant-lease';
import { forEachSequential } from '@/src/lib/async/sequential';
import { buildNotificationFrame, pushNotificationToDid } from './ws-push';
import { pushWebNotificationToOperator } from './web-push';

const SCOPE = 'delegation.grant.expiring';

/** Existing notification PK is the durable concurrency/restart-safe grant+expiry dedupe. */
async function notifyExpiringGrant(grant: {
  grantId: string; delegatorDid: string; agentDid: string; expiresAt: Date;
}, now: Date): Promise<boolean> {
  const expiresAt = grant.expiresAt.toISOString();
  const id = `ntf_grant_expiry_${createHash('sha256').update(JSON.stringify([grant.grantId, expiresAt])).digest('hex')}`;
  const title = 'Agent approval grant expiring';
  const body = operatorGrantExpiryWarning({ status: 'active', expiresAt, capabilities: ['operator:approvals'] }, now.getTime());
  const data = { grantId: grant.grantId, agentDid: grant.agentDid, expiresAt, url: '/auth/agents' };
  const [pref] = await db.select({ inapp: preferences.inapp }).from(preferences)
    .where(and(eq(preferences.did, grant.delegatorDid), eq(preferences.scope, SCOPE))).limit(1);
  const inserted = await db.insert(notifications).values({
    id, recipientDid: grant.delegatorDid, scope: SCOPE, urgency: 'high', title, body, data,
    channelsSent: ['inapp'], read: false, createdAt: now,
  }).onConflictDoNothing({ target: notifications.id }).returning({ id: notifications.id });
  if (inserted.length === 0) return false;
  if (pref?.inapp !== false) {
    await pushNotificationToDid(grant.delegatorDid, buildNotificationFrame({ id, scope: SCOPE, title, body, data, createdAt: now }));
    await pushWebNotificationToOperator(grant.delegatorDid, { title, body, url: '/auth/agents' });
  }
  return true;
}

/** Runs without an open browser; expired/revoked grants and revoked capabilities never notify. */
export async function notifyExpiringOperatorGrants(now = new Date()) {
  const grants = await db.select({
    grantId: delegationGrants.id, delegatorDid: delegationGrants.delegatorDid,
    agentDid: delegationGrants.agentDid, expiresAt: delegationGrants.expiresAt,
  }).from(delegationGrants)
    .innerJoin(delegationGrantCapabilities, eq(delegationGrantCapabilities.grantId, delegationGrants.id))
    .where(and(
      eq(delegationGrants.status, 'active'),
      eq(delegationGrantCapabilities.status, 'active'),
      eq(delegationGrantCapabilities.capability, 'operator:approvals'),
      gt(delegationGrants.expiresAt, now),
      lte(delegationGrants.expiresAt, new Date(now.getTime() + GRANT_DEFAULT_TTL)),
    ));
  // Sequential delivery bounds push traffic and database pressure.
  let notified = 0;
  await forEachSequential(grants, async grant => {
    if (await notifyExpiringGrant(grant, now)) notified += 1;
  });
  return { checked: grants.length, notified };
}
