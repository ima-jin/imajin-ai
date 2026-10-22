import { describe, expect, it } from 'vitest';
import { previousGrantLeaseMs, operatorGrantExpiryWarning } from '../grant-lease';

const DAY = 86400000;
const NOW = Date.parse('2026-10-21T00:00:00Z');

describe('previousGrantLeaseMs', () => {
  it.each([7, 30, 60])('preserves a %s day lease up to the existing max', days => {
    expect(previousGrantLeaseMs({
      issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + days * DAY).toISOString(), history: [],
    })).toBe(Math.min(days, 30) * DAY);
  });
  it('uses the latest renewal, not unrelated updates or history order', () => {
    expect(previousGrantLeaseMs({
      issuedAt: new Date(NOW - 100 * DAY).toISOString(), expiresAt: new Date(NOW + 7 * DAY).toISOString(),
      history: [
        { event: 'renewed', createdAt: new Date(NOW).toISOString() },
        { event: 'capability_added', createdAt: new Date(NOW + DAY).toISOString() },
        { event: 'renewed', createdAt: new Date(NOW - DAY).toISOString() },
      ],
    })).toBe(7 * DAY);
  });
  it.each(['invalid', new Date(NOW - DAY).toISOString()])('falls back for unusable legacy expiry %s', expiresAt => {
    expect(previousGrantLeaseMs({ issuedAt: new Date(NOW).toISOString(), expiresAt, history: [] })).toBe(DAY);
  });
});

describe('operatorGrantExpiryWarning', () => {
  it('does not render a warning for a malformed legacy expiry', () => {
    expect(operatorGrantExpiryWarning({ status: 'active', capabilities: ['operator:approvals'], expiresAt: 'invalid' }, NOW)).toBeNull();
  });
  it.each([
    ['active', ['operator:approvals'], DAY, true],
    ['active', ['operator:approvals'], 1, true],
    ['active', ['operator:approvals'], DAY + 1, false],
    ['active', ['operator:approvals'], 0, false],
    ['active', ['operator:approvals'], -1, false],
    ['revoked', ['operator:approvals'], DAY, false],
    ['active', ['messages:write'], DAY, false],
  ])('checks status %s, capabilities %s and remaining %s', (status, capabilities, remaining, warns) => {
    expect(operatorGrantExpiryWarning({ status, capabilities, expiresAt: new Date(NOW + remaining).toISOString() }, NOW) !== null).toBe(warns);
  });
});
