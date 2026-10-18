export interface MailDeliverySafety {
  retryable?: false;
  deliveredMayHaveOccurred?: true;
}

interface MailDeliveryFailure extends MailDeliverySafety {
  error: string;
}

const AUDIT_FAILED_AFTER_DELIVERY = 'mail_audit_failed_after_delivery_do_not_retry';

/** Expose only the kernel's safe audit outcome, never raw provider details. */
export function mailDeliveryFailure(error: unknown, fallback: string): MailDeliveryFailure {
  if (error !== AUDIT_FAILED_AFTER_DELIVERY) return { error: fallback };
  return { error: AUDIT_FAILED_AFTER_DELIVERY, retryable: false, deliveredMayHaveOccurred: true };
}
