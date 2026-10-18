import { randomUUID } from 'node:crypto';
import { sendEmail, type SendEmailOptions } from '@imajin/email';
import { db, attestations } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { createAttestationEntry } from '@/src/lib/auth/dfos';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { resolveMailSenderContext, type SenderResolution } from './resolver';
import { validateReplyTo } from './validation';
import type { MailPurpose } from './types';

export interface KernelEmailOptions extends SendEmailOptions {
  purpose: MailPurpose;
  ownerDid?: string;
  appDid?: string;
  /** Opaque non-secret record identifier; never an address, URL, token, or message text. */
  messageRef?: string;
}

/** Provider delivery and DB/relay writes cannot share an atomic transaction. */
export async function sendKernelEmail(options: KernelEmailOptions): ReturnType<typeof sendEmail> {
  const { purpose, ownerDid, appDid, messageRef } = options;
  const ref = messageRef ?? `mail_${randomUUID()}`;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ref)) return { success: false, error: 'invalid_mail_message_ref' };
  let row: Awaited<ReturnType<typeof prepareMechanicalAttestation>>;
  let sender: SenderResolution;
  try {
    if (options.replyTo !== undefined) validateReplyTo(options.replyTo);
    const resolved = await resolveMailSenderContext({ purpose, ownerDid, appDid });
    const owner = resolved.ownerDid;
    sender = resolved.sender;
    const nodeDid = await getNodeDid();
    if (!nodeDid) throw new Error('Missing node DID');
    row = await prepareMechanicalAttestation({
      type: 'mail.sent',
      subjectDid: appDid || owner || nodeDid,
      contextId: ref,
      contextType: 'mail',
      payload: { purpose, onBehalfOfDid: appDid || owner || nodeDid, messageRef: ref, sentByNodeDid: nodeDid, from: sender.from },
    });
  } catch {
    return { success: false, error: 'mail_signing_or_sender_unavailable' };
  }
  const replyTo = options.replyTo ?? sender.replyTo;
  const result = await sendEmail({
    to: options.to, subject: options.subject, html: options.html,
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(options.unsubscribeUrl !== undefined ? { unsubscribeUrl: options.unsubscribeUrl } : {}),
    from: sender.from, ...(replyTo ? { replyTo } : {}),
  });
  if (!result.success) return result;
  try {
    await db.insert(attestations).values(row);
    const chained = await createAttestationEntry({
      issuer_did: row.issuerDid, subject_did: row.subjectDid, type: row.type,
      context_id: row.contextId, context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt,
    });
    if (!chained) throw new Error('DFOS record unavailable');
    return result;
  } catch {
    // Delivery may already have occurred. Do not retry automatically or claim an audited success.
    return { success: false, messageId: result.messageId, error: 'mail_audit_failed_after_delivery_do_not_retry' };
  }
}
