import type { SendEmailOptions } from '../types';

export interface EmailProvider {
  send(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }>;
}

/** Provider responses can echo the full message or credentials; only HTTP status is safe for sensitive mail. */
export function providerLogFields(options: SendEmailOptions, fields: Record<string, unknown>): Record<string, unknown> {
  if (!options.sensitive) return fields;
  return typeof fields.status === 'number' ? { status: fields.status } : {};
}
