import type { BrokerRejection, BrokerRejectionReason } from '../types';

/**
 * Build a BrokerRejection. Extracts the repeated literal object construction
 * that appears across consent, scope, and the new match reactors.
 */
export function makeRejection(
  fields: string[],
  reason: BrokerRejectionReason,
  details: string
): BrokerRejection {
  return { status: 'rejected', reason, fields, details };
}
