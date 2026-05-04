import { createLogger } from '@imajin/logger';
import type { EmailProvider } from './types';
import type { SendEmailOptions } from '../types';
import { parseSender } from '../types';

const log = createLogger('email:sendgrid');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || 'Jin <jin@imajin.ai>';

export class SendGridProvider implements EmailProvider {
  async send(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
    if (!SENDGRID_API_KEY) {
      log.warn({ to: options.to }, 'SENDGRID_API_KEY not set — skipping email');
      return { success: false, error: 'No API key configured' };
    }

    const headers: Record<string, string> = {};
    if (options.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${options.unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: options.to }] }],
          from: parseSender(SENDGRID_FROM),
          ...(options.replyTo && { reply_to: { email: options.replyTo } }),
          subject: options.subject,
          content: [
            { type: 'text/plain', value: options.text || '' },
            { type: 'text/html', value: options.html },
          ],
          ...(Object.keys(headers).length > 0 && { headers }),
        }),
      });

      if (res.status === 202) {
        log.info({ to: options.to }, 'Email sent via SendGrid');
        return { success: true, messageId: res.headers.get('x-message-id') ?? undefined };
      } else {
        const body = await res.text();
        log.error({ status: res.status, body }, 'SendGrid error');
        return { success: false, error: `SendGrid ${res.status}: ${body}` };
      }
    } catch (error) {
      log.error({ err: String(error) }, 'SendGrid send failed');
      return { success: false, error };
    }
  }
}
