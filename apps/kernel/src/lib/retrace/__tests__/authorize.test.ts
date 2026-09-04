/**
 * Unit tests for `canReadHop` (#1962) — composition of party/org-member/
 * disclosure-scope checks. `isActiveGroupMember` is mocked (it hits the
 * DB); `isPartyToAttestation`/`resolveDisclosureAccess` are pure and used
 * for real, matching how `GET /auth/api/attestations` already tests them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isActiveGroupMemberMock } = vi.hoisted(() => ({ isActiveGroupMemberMock: vi.fn() }));
vi.mock('@/src/lib/auth/group-membership', () => ({ isActiveGroupMember: isActiveGroupMemberMock }));

import { canReadHop } from '../authorize';
import type { HopAudience } from '../types';

const VIEWER = 'did:imajin:viewer';

function audience(overrides: Partial<HopAudience> = {}): HopAudience {
  return { subjectDid: 'did:imajin:subject', actorDid: 'did:imajin:actor', delegatorDid: null, disclosureScope: null, ...overrides };
}

beforeEach(() => {
  isActiveGroupMemberMock.mockReset();
  isActiveGroupMemberMock.mockResolvedValue(false);
});

describe('canReadHop', () => {
  it('allows the subject without consulting org membership or disclosure scope', async () => {
    const result = await canReadHop(VIEWER, audience({ subjectDid: VIEWER }), null);
    expect(result).toBe(true);
    expect(isActiveGroupMemberMock).not.toHaveBeenCalled();
  });

  it('allows the actor', async () => {
    expect(await canReadHop(VIEWER, audience({ actorDid: VIEWER }), null)).toBe(true);
  });

  it('allows the delegator', async () => {
    expect(await canReadHop(VIEWER, audience({ delegatorDid: VIEWER }), null)).toBe(true);
  });

  it('allows an active identity_members member of the subject org', async () => {
    isActiveGroupMemberMock.mockImplementation(async (ownerDid: string, memberDid: string) => ownerDid === 'org:subject' && memberDid === VIEWER);
    expect(await canReadHop(VIEWER, audience({ subjectDid: 'org:subject' }), null)).toBe(true);
  });

  it('allows an active identity_members member of the actor org', async () => {
    isActiveGroupMemberMock.mockImplementation(async (ownerDid: string, memberDid: string) => ownerDid === 'org:actor' && memberDid === VIEWER);
    expect(await canReadHop(VIEWER, audience({ actorDid: 'org:actor' }), null)).toBe(true);
  });

  it('denies a non-party, non-member viewer when disclosureScope is null', async () => {
    expect(await canReadHop(VIEWER, audience({ disclosureScope: null }), null)).toBe(false);
  });

  it("falls back to disclosure_scope 'public' for a non-party viewer", async () => {
    expect(await canReadHop(VIEWER, audience({ disclosureScope: 'public' }), null)).toBe(true);
  });

  it("falls back to disclosure_scope 'connections' via the trust-graph radius", async () => {
    const connected = new Set(['did:imajin:subject']);
    expect(await canReadHop(VIEWER, audience({ disclosureScope: 'connections' }), connected)).toBe(true);
  });

  it("denies disclosure_scope 'parties' for a non-party, non-connected viewer", async () => {
    expect(await canReadHop(VIEWER, audience({ disclosureScope: 'parties' }), new Set())).toBe(false);
  });
});
