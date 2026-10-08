// @vitest-environment jsdom
/**
 * Guest list default view (#2734): shows every ticket that holds a seat
 * (valid, used, legacy sold); held / cancelled / refunded stay behind their pills.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ guests: [] as unknown[] }));

vi.mock('@imajin/ui', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@imajin/config', () => ({
  apiFetch: async () => ({ json: async () => ({ guests: mocks.guests }) }),
}));
vi.mock('../ticket-scanner', () => ({ TicketScanner: () => null }));

import { GuestList } from '../guest-list';

function guest(id: string, status: string) {
  return {
    id,
    status,
    ownerDid: `did:imajin:${id}`,
    pricePaid: 1000,
    currency: 'CAD',
    purchasedAt: null,
    usedAt: null,
    ticketType: 'General',
    paymentMethod: null,
    paymentId: null,
    holdExpiresAt: null,
    profile: null,
    registrationStatus: null,
    attendeeName: null,
    lastEmailSentAt: null,
    fairSettlement: null,
    orderAmountTotal: null,
  };
}

afterEach(cleanup);

describe('GuestList default view', () => {
  it('counts valid, used and sold tickets as confirmed; hides held, cancelled and refunded', async () => {
    mocks.guests = [
      guest('g1', 'valid'),
      guest('g2', 'used'),
      guest('g3', 'sold'),
      guest('g4', 'held'),
      guest('g5', 'cancelled'),
      guest('g6', 'refunded'),
    ];

    render(<GuestList eventId="evt_1" isOwner autoExpand />);

    expect(await screen.findByText('3 of 6 tickets')).toBeTruthy();
    expect(screen.getByText('General (3)')).toBeTruthy();
    // Non-default statuses still get pills so organizers can reveal them.
    expect(screen.getByText('held (1)')).toBeTruthy();
    expect(screen.getByText('cancelled (1)')).toBeTruthy();
  });
});
