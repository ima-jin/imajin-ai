import { describe, expect, it } from 'vitest';
import { approvalAge, approvalExpiryDays, approvalExpiryReason, isApprovalActionable, type ApprovalAttention } from '../approval-attention';

const now = Date.parse('2026-10-22T00:00:00.000Z');
const card: ApprovalAttention = { source: 'system-agent', kind: 'system-agent:restart', status: 'pending', createdAt: new Date(now - 3600_000) };
const day = 86_400_000;

describe('shared approval attention policy', () => {
  it.each(['pending', 'approved'])('includes a fresh %s item with a real action', status => {
    expect(isApprovalActionable({ ...card, status }, now)).toBe(true);
  });
  it.each(['denied', 'rejected', 'resolved', 'withdrawn', 'expired', 'applied', 'superseded', 'gone', 'unknown'])('excludes %s history', status => {
    expect(isApprovalActionable({ ...card, status }, now)).toBe(false);
  });
  it.each([
    { archivedAt: '2026-10-22' }, { appliedAt: '2026-10-22' }, { sessionOutcome: { outcome: 'completed' } },
    { status: 'approved', nativeDecision: true }, { source: 'decision', kind: 'decision:card', status: 'approved' },
    { source: 'reach', kind: 'reach:message', status: 'approved' }, { source: 'knock', kind: 'knock:request', status: 'approved' },
  ])('does not count resolved or reader-hidden items: %j', change => {
    expect(isApprovalActionable({ ...card, ...change }, now)).toBe(false);
  });
  it.each(['pending', 'approved'])('expires %s at the default seven-day boundary', status => {
    expect(approvalExpiryReason({ ...card, status, createdAt: new Date(now - 7 * day) }, now)).toMatch(/deadline/);
    expect(approvalExpiryReason({ ...card, status, createdAt: new Date(now - 7 * day + 1) }, now)).toBeNull();
  });
  it('uses source deadlines, N-day fallback and a hard pending age limit', () => {
    expect(approvalExpiryReason({ ...card, detail: { expiresAt: new Date(now).toISOString() } }, now)).not.toBeNull();
    expect(approvalExpiryReason({ ...card, status: 'approved', createdAt: new Date(now - 30 * day), detail: { expiresAt: new Date(now + day).toISOString() } }, now)).toBeNull();
    expect(approvalExpiryReason({ ...card, createdAt: new Date(now - 3 * day), detail: { expiresAt: 'invalid' } }, now, 2)).not.toBeNull();
    expect(approvalExpiryReason({ ...card, createdAt: new Date(now - 8 * day), detail: { expiresAt: new Date(now + day).toISOString() } }, now)).not.toBeNull();
  });
  it.each([undefined, '', 'garbage', '-1', '0', 'Infinity'])('defaults invalid N=%s safely', value => {
    expect(approvalExpiryDays(value)).toBe(7);
  });
  it('honors positive configuration and does not expire terminal or applied rows', () => {
    expect(approvalExpiryDays('2.5')).toBe(2.5);
    expect(approvalExpiryReason({ ...card, status: 'denied' }, now)).toBeNull();
    expect(approvalExpiryReason({ ...card, appliedAt: new Date() }, now)).toBeNull();
    expect(approvalExpiryReason({ ...card, createdAt: 'invalid' }, now)).toBeNull();
  });
  it.each([[0, 'just now'], [60_000, '1m old'], [3600_000, '1h old'], [8 * day, '8d old'], [-1, 'just now']])('shows age for %i ms', (age, expected) => {
    expect(approvalAge(new Date(now - Number(age)).toISOString(), now)).toBe(expected);
  });
  it('labels unknown age honestly', () => { expect(approvalAge('invalid', now)).toBe('age unknown'); });
});
