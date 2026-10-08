/**
 * Tests for apps/events/src/lib/ticket-holding.ts (#2734)
 */
import { describe, it, expect } from 'vitest';
import {
  HOLDING_TICKET_STATUSES,
  holdingTicketStatuses,
  isHoldingTicketStatus,
} from '../lib/ticket-holding';
import { NON_HOLDING_STATUSES } from './support/ticket-status-fake-db';

describe('ticket-holding', () => {
  it('counts valid, sold (legacy) and used as held', () => {
    expect([...HOLDING_TICKET_STATUSES].sort()).toEqual(['sold', 'used', 'valid']);
  });

  it.each(['valid', 'sold', 'used'])('isHoldingTicketStatus(%s) is true', (status) => {
    expect(isHoldingTicketStatus(status)).toBe(true);
  });

  it.each([...NON_HOLDING_STATUSES, '', null, undefined])('isHoldingTicketStatus(%s) is false', (status) => {
    expect(isHoldingTicketStatus(status as string | null | undefined)).toBe(false);
  });

  it('holdingTicketStatuses() returns a fresh mutable copy', () => {
    const a = holdingTicketStatuses();
    a.push('valid');
    expect(holdingTicketStatuses()).toEqual([...HOLDING_TICKET_STATUSES]);
  });
});
