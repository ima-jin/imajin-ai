export const MAIL_PURPOSES = ['signin', 'receipts', 'notifications', 'contact'] as const;
export type MailPurpose = typeof MAIL_PURPOSES[number];

export interface SenderConfig {
  ownerDid: string;
  purpose: MailPurpose;
  /** Empty string selects the owner's default for this purpose. */
  appDid: string;
  domain: string;
  localPart: string;
  displayName: string;
  replyTo: string | null;
}

export const DEFAULT_SENDERS: Record<MailPurpose, string> = {
  signin: 'Signin <signin@imajin.ai>',
  receipts: 'Receipts <receipts@imajin.ai>',
  notifications: 'Notifications <notifications@imajin.ai>',
  contact: 'Imajin <info@imajin.ai>',
};
