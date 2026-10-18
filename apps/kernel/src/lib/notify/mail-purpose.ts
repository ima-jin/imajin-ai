import type { MailPurpose } from '@/src/lib/mail/types';

// Kernel-owned exact scopes, never a caller-supplied mail purpose or prefix match.
const RECEIPT_SCOPES = new Set([
  'event:ticket-receipt',
  'market:purchase',
  'coffee:tip-sent',
  'pay:payment_request-paid',
  'pay:payment_request-settled',
]);

export function notificationMailPurpose(scope: string): MailPurpose {
  return RECEIPT_SCOPES.has(scope) ? 'receipts' : 'notifications';
}
