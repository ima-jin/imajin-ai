import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db and crypto dependencies before importing the module under test.
vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
  invitesInConnections: {},
  podsInConnections: {},
  podMembersInConnections: {},
  connections: {},
  profiles: {},
  mailingLists: {},
  subscriptions: {},
  contacts: {},
}));

vi.mock('@/src/lib/auth/crypto', () => ({
  verifySignature: vi.fn(),
}));

vi.mock('@/src/lib/kernel/utils', () => ({ generateId: vi.fn(() => 'mock_id') }));
vi.mock('@imajin/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/src/lib/www/subscribe-tokens', () => ({
  generateVerifyToken: vi.fn(() => 'tok'),
  verifyTokenExpiry: vi.fn(() => 9999),
}));
vi.mock('@/src/lib/www/verify-email-template', () => ({
  verificationEmail: vi.fn(() => '<html>'),
  verificationEmailText: vi.fn(() => 'text'),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));

import { verifyRegistrationSignature, resolveInviteCode } from '../register';
import { verifySignature } from '@/src/lib/auth/crypto';
import { db } from '@/src/db';

const mockVerify = vi.mocked(verifySignature);

describe('verifyRegistrationSignature', () => {
  const PK = 'abc123';
  const SIG = 'sig';

  beforeEach(() => {
    mockVerify.mockReset();
  });

  it('returns true when the timestamped payload verifies', async () => {
    mockVerify.mockResolvedValueOnce(true);
    const result = await verifyRegistrationSignature(PK, 'alice', 'Alice', 'actor', 'human', 'human', SIG);
    expect(result).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('falls back to simple payload when timestamped fails', async () => {
    mockVerify
      .mockResolvedValueOnce(false) // timestamped
      .mockResolvedValueOnce(true); // simple
    const result = await verifyRegistrationSignature(PK, 'alice', 'Alice', 'actor', 'human', 'human', SIG);
    expect(result).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy payload when both previous fail', async () => {
    mockVerify
      .mockResolvedValueOnce(false) // timestamped
      .mockResolvedValueOnce(false) // simple
      .mockResolvedValueOnce(true); // legacy
    const result = await verifyRegistrationSignature(PK, 'alice', 'Alice', 'actor', 'human', 'human', SIG);
    expect(result).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(3);
  });

  it('returns false when all three payloads fail', async () => {
    mockVerify.mockResolvedValue(false);
    const result = await verifyRegistrationSignature(PK, 'alice', 'Alice', 'actor', 'human', 'human', SIG);
    expect(result).toBe(false);
    expect(mockVerify).toHaveBeenCalledTimes(3);
  });
});

describe('resolveInviteCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:true with null inviteData for service registrations', async () => {
    const result = await resolveInviteCode(undefined, true, false);
    expect(result).toEqual({ ok: true, inviteData: null });
  });

  it('returns ok:true with null inviteData when gate is disabled and no code', async () => {
    const result = await resolveInviteCode(undefined, false, true);
    expect(result).toEqual({ ok: true, inviteData: null });
  });

  it('returns ok:false when gate is enabled and no invite code provided', async () => {
    const result = await resolveInviteCode(undefined, false, false);
    expect(result).toEqual({
      ok: false,
      error: 'Imajin is invite-only. You need an invite code to register.',
      status: 403,
    });
  });

  it('returns ok:true with inviteData when a valid invite is found', async () => {
    // Mock db chain returning a valid pending invite
    const mockInvite = { status: 'pending', usedCount: 0, maxUses: 5, fromDid: 'did:alice', fromHandle: 'alice' };
    // The db select chain returns [mockInvite] from .limit()
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockInvite]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await resolveInviteCode('INVITE123', false, false);
    expect(result).toEqual({ ok: true, inviteData: { fromDid: 'did:alice', fromHandle: 'alice' } });
  });

  it('returns ok:false when the invite is exhausted and gate is enabled', async () => {
    const mockInvite = { status: 'pending', usedCount: 5, maxUses: 5, fromDid: 'did:alice', fromHandle: 'alice' };
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockInvite]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await resolveInviteCode('USED', false, false);
    expect(result).toEqual({
      ok: false,
      error: 'This invite has already been used',
      status: 403,
    });
  });

  it('returns ok:false when the invite is invalid/expired and gate is enabled', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // not found
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await resolveInviteCode('BADCODE', false, false);
    expect(result).toEqual({
      ok: false,
      error: 'Invalid or expired invite code',
      status: 403,
    });
  });

  it('returns ok:true with null inviteData when gate is disabled but invite is invalid', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await resolveInviteCode('BADCODE', false, true); // gate disabled
    expect(result).toEqual({ ok: true, inviteData: null });
  });
});
