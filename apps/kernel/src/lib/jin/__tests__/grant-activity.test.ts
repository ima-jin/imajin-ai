import { describe, expect, it } from 'vitest';
import { isGrantUnused30d, sortGrantsByActivity } from '../grant-activity';
import type { GrantCard, GrantSourceKind } from '../grants-lane';

const now = Date.parse('2026-11-22T12:00:00Z');
const cutoff = now - 30 * 86_400_000;
function card(overrides: Partial<GrantCard> = {}): GrantCard {
  return {
    id: 'grant', source: 'app-authorization', grantee: 'Test app', capabilities: [],
    issuedAt: new Date(cutoff - 1).toISOString(), lastUsedAt: null,
    status: 'active', revocable: true, revoke: { method: 'POST', path: '/api/auth/revoke' },
    ackState: null, ackEvidence: null, ...overrides,
  };
}

describe('idle grants (#3009)', () => {
  it.each(['auth-grant', 'vault-delegation', 'access-bearer', 'app-authorization'] as GrantSourceKind[])('flags %s at exactly 30d, not one millisecond sooner', source => {
    for (const lastUsedAt of [null, new Date(cutoff).toISOString()]) {
      expect(isGrantUnused30d(card({ source, issuedAt: new Date(cutoff).toISOString(), lastUsedAt }), now)).toBe(true);
      expect(isGrantUnused30d(card({ source, issuedAt: new Date(cutoff).toISOString(), lastUsedAt }), now - 1)).toBe(false);
    }
    expect(isGrantUnused30d(card({ source, lastUsedAt: new Date(now).toISOString() }), now)).toBe(false);
  });

  it.each([
    { status: 'revoked' }, { status: 'expired' }, { status: 'consumed' },
    { expiresAt: new Date(now).toISOString() }, { source: 'auth-membership' as const },
    { issuedAt: null }, { lastUsedAt: 'not-a-date' },
  ])('does not label ineligible or unknown evidence %j', overrides => {
    expect(isGrantUnused30d(card(overrides), now)).toBe(false);
  });

  it('prioritizes idle grants within each source, keeps source positions and revoke actions, and never mutates input', () => {
    const cards = [
      card({ id: 'app-recent', issuedAt: '2026-11-22', lastUsedAt: '2026-11-22' }),
      card({ id: 'auth-recent', source: 'auth-grant', issuedAt: '2026-11-21', lastUsedAt: '2026-11-21' }),
      card({ id: 'app-idle', issuedAt: '2026-10-01' }),
      card({ id: 'auth-idle', source: 'auth-grant', issuedAt: '2026-09-01' }),
    ];
    const before = structuredClone(cards);
    expect(sortGrantsByActivity(cards, now).map(value => value.id)).toEqual(['app-idle', 'auth-idle', 'app-recent', 'auth-recent']);
    expect(cards).toEqual(before);
    expect(sortGrantsByActivity([], now)).toEqual([]);
  });
});
