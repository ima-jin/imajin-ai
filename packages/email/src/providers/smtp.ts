import { createLogger } from '@imajin/logger';
import type { EmailProvider } from './types';
import type { SendEmailOptions } from '../types';
import nodemailer from 'nodemailer';

const log = createLogger('email:smtp');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'Jin <jin@imajin.ai>';

export class SmtpProvider implements EmailProvider {
  async send(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      log.warn({ to: options.to }, 'SMTP_HOST, SMTP_USER, or SMTP_PASS not set — skipping email');
      return { success: false, error: 'SMTP not fully configured' };
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    try {
      const info = await transporter.sendMail({
        from: SMTP_FROM,
        to: options.to,
        subject: options.subject,
        text: options.text || '',
        html: options.html,
        ...(options.replyTo && { replyTo: options.replyTo }),
        ...(options.unsubscribeUrl && {
          list: {
            unsubscribe: {
              url: options.unsubscribeUrl,
              comment: 'Unsubscribe from this mailing list',
            },
          },
        }),
      });

      log.info({ to: options.to, messageId: info.messageId }, 'Email sent via SMTP');
      return { success: true, messageId: info.messageId };
    } catch (error) {
      log.error({ err: String(error) }, 'SMTP send failed');
      return { success: false, error };
    }
  }
}
