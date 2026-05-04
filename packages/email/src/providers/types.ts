import type { SendEmailOptions } from '../types';

export interface EmailProvider {
  send(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }>;
}
