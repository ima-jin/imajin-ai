import { nanoid } from 'nanoid';
import { sendEmail } from '@imajin/email';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { db, onboardTokens } from '@/src/db';
import { onboardEmail } from './onboard-email';

type DeliveryInput = Pick<typeof onboardTokens.$inferInsert,
  'email' | 'name' | 'redirectUrl' | 'context' | 'scopeDid' | 'inviteCode'> & {
  wantPolling?: boolean;
  onBehalfOf?: string;
};

/** The verification bearer never leaves kernel storage and email delivery. */
export async function deliverOnboardEmail(input: DeliveryInput): Promise<{
  success: boolean;
  pollHandle?: string;
}> {
  const token = nanoid(48);
  const pollHandle = input.wantPolling ? nanoid(24) : null;
  await db.insert(onboardTokens).values({
    id: `obt_${nanoid(16)}`,
    email: input.email,
    name: input.name ?? null,
    token,
    redirectUrl: input.redirectUrl ?? null,
    context: input.context ?? null,
    scopeDid: input.scopeDid ?? null,
    inviteCode: input.inviteCode ?? null,
    pollHandle,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  const verifyUrl = `${buildPublicUrlAbsolute('auth')}/api/onboard/verify?token=${token}`;
  const result = await sendEmail({
    to: input.email,
    sensitive: true,
    subject: `Verify your email${input.context ? ` to ${input.context}` : ''} — Imajin`,
    html: onboardEmail({
      verifyUrl, context: input.context ?? undefined, name: input.name ?? undefined,
      onBehalfOf: input.onBehalfOf,
    }),
  });
  return { success: result.success, ...(pollHandle ? { pollHandle } : {}) };
}
