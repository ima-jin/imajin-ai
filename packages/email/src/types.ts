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
  const match = from.match(/^(.+)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from };
}
