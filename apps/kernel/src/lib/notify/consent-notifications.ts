import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  registerConsentNotificationPreparer, type ConsentNotification, type PreparedConsentNotification,
} from '@imajin/bus';
import { db, notifications, preferences, profiles, identities, credentials } from '@/src/db';
import { getTemplate } from './template-store';
import { buildNotificationFrame, pushNotificationToDid } from './ws-push';
import { sendKernelEmail } from '@/src/lib/mail/send';
import { notificationMailPurpose } from './mail-purpose';

async function recipientEmail(did: string): Promise<string | undefined> {
  const [profile] = await db.select({ email: profiles.contactEmail }).from(profiles).where(eq(profiles.did, did)).limit(1);
  if (profile?.email) return profile.email;
  const [identity] = await db.select({ email: identities.contactEmail }).from(identities).where(eq(identities.id, did)).limit(1);
  if (identity?.email) return identity.email;
  const [credential] = await db.select({ email: credentials.value }).from(credentials)
    .where(and(eq(credentials.did, did), eq(credentials.type, 'email'))).limit(1);
  return credential?.email ?? undefined;
}

/** Resolve metadata before checkout; persist under the dedupe lock; push after commit. */
export async function prepareConsentNotification(input: ConsentNotification): Promise<PreparedConsentNotification> {
  if (input.scope !== 'broker:consent-request' || !input.to.startsWith('did:')) {
    throw new Error('Invalid internal consent notification');
  }
  const template = await getTemplate(input.scope);
  const [pref] = await db.select().from(preferences)
    .where(and(eq(preferences.did, input.to), eq(preferences.scope, input.scope))).limit(1);
  const emailEnabled = pref ? pref.email : true;
  const inappEnabled = pref ? pref.inapp : true;
  const email = emailEnabled && template?.email ? await recipientEmail(input.to) : undefined;
  const id = `ntf_${randomUUID()}`;
  const createdAt = new Date();
  const title = template?.title(input.data) ?? input.scope;
  const body = template?.body(input.data);
  return {
    async persist(tx) {
      await tx.unsafe(`
        INSERT INTO notify.notifications
          (id,recipient_did,scope,urgency,title,body,data,channels_sent,read,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,ARRAY[]::text[],false,$8)
      `, [id, input.to, input.scope, input.urgency, title, body ?? null, JSON.stringify(input.data), createdAt]);
    },
    async deliver() {
      const channels: string[] = [];
      if (inappEnabled) {
        const delivered = await pushNotificationToDid(input.to,
          buildNotificationFrame({ id, scope: input.scope, title, body, data: input.data, createdAt }));
        channels.push('inapp');
        if (delivered) channels.push('ws');
      }
      if (email && template?.email) {
        const result = await sendKernelEmail({
          purpose: notificationMailPurpose(input.scope), messageRef: id, to: email,
          subject: template.email.subject(input.data), html: template.email.html(input.data),
        });
        if (result.success) channels.push('email');
      }
      if (channels.length > 0) {
        await db.update(notifications).set({ channelsSent: channels }).where(eq(notifications.id, id));
      }
    },
  };
}

export function registerConsentNotifications(): void {
  registerConsentNotificationPreparer(prepareConsentNotification);
}
