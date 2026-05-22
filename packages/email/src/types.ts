export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** When set, adds List-Unsubscribe / List-Unsubscribe-Post headers and a footer link */
  unsubscribeUrl?: string;
  /** Reply-To address (e.g. event organizer email) */
  replyTo?: string;
}

export function parseSender(from: string): { email: string; name?: string } {
  const lt = from.indexOf('<');
  const gt = from.lastIndexOf('>');
  if (lt > 0 && gt > lt) return { name: from.slice(0, lt).trim(), email: from.slice(lt + 1, gt).trim() };
  return { email: from };
}
