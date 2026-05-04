import { createLogger } from '@imajin/logger';
import type { EmailProvider } from './types';
import type { SendEmailOptions } from '../types';

const log = createLogger('email:postal');

const POSTAL_API_URL = process.env.POSTAL_API_URL;
const POSTAL_API_KEY = process.env.POSTAL_API_KEY;
const POSTAL_FROM = process.env.POSTAL_FROM || process.env.EMAIL_FROM || 'Jin <jin@imajin.ai>';

export class PostalProvider implements EmailProvider {
  async send(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
    if (!POSTAL_API_URL) {
      log.warn({ to: options.to }, 'POSTAL_API_URL not set — skipping email');
      return { success: false, error: 'POSTAL_API_URL not configured' };
    }
    if (!POSTAL_API_KEY) {
      log.warn({ to: options.to }, 'POSTAL_API_KEY not set — skipping email');
      return { success: false, error: 'POSTAL_API_KEY not configured' };
    }

    const fromMatch = POSTAL_FROM.match(/^(.+)\s*<(.+)>$/);
    const fromName = fromMatch ? fromMatch[1].trim() : undefined;
    const fromEmail = fromMatch ? fromMatch[2].trim() : POSTAL_FROM;

    const body: Record<string, any> = {
      to: [options.to],
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      sender: fromEmail,
      subject: options.subject,
      html_body: options.html,
      plain_body: options.text || '',
    };

    if (options.replyTo) {
      body.reply_to = options.replyTo;
    }

    try {
      const res = await fetch(`${POSTAL_API_URL.replace(/\/$/, '')}/api/v1/send/message`, {
        method: 'POST',
        headers: {
          'X-Server-API-Key': POSTAL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const resBody = await res.json().catch(() => null);

      if (res.status === 200 && resBody?.status === 'success') {
        log.info({ to: options.to, messageId: resBody.data?.message_id }, 'Email sent via Postal');
        return { success: true, messageId: resBody.data?.message_id };
      } else {
        log.error({ status: res.status, body: resBody }, 'Postal error');
        return { success: false, error: `Postal ${res.status}: ${JSON.stringify(resBody)}` };
      }
    } catch (error) {
      log.error({ err: String(error) }, 'Postal send failed');
      return { success: false, error };
    }
  }
}
