import { SendGridProvider } from './sendgrid';
import { PostalProvider } from './postal';
import { SmtpProvider } from './smtp';
import type { EmailProvider } from './types';

export { SendGridProvider, PostalProvider, SmtpProvider };
export type { EmailProvider };
export type { SendEmailOptions } from '../types';

export function getProvider(): EmailProvider {
  const provider = process.env.EMAIL_PROVIDER || 'sendgrid';
  switch (provider) {
    case 'postal': return new PostalProvider();
    case 'smtp': return new SmtpProvider();
    case 'sendgrid':
    default:
      return new SendGridProvider();
  }
}
