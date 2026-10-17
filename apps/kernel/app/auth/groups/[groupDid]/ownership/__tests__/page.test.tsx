// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { effective } = vi.hoisted(() => ({ effective: vi.fn() }));
vi.mock('@/app/auth/lib/get-effective-did', () => ({ getEffectiveDid: effective }));
vi.mock('@/app/auth/components/IdentityOwnershipPanel', () => ({
  default: ({ groupDid }: { groupDid: string }) => <div>ownership:{groupDid}</div>,
}));
import OwnershipPage from '../page';

afterEach(cleanup);

describe('recipient ownership invitation page', () => {
  it.each(['did:imajin:group', 'did%3Aimajin%3Agroup'])('normalizes route DID %s for the API-gated panel without act-as membership', async (groupDid) => {
    effective.mockResolvedValue({ sessionDid: 'did:imajin:bob', effectiveDid: 'did:imajin:bob' });
    render(await OwnershipPage({ params: Promise.resolve({ groupDid }) }));
    expect(screen.getByText('ownership:did:imajin:group')).toBeTruthy();
  });

  it('preserves the invitation destination through sign-in', async () => {
    effective.mockResolvedValue({ sessionDid: null });
    render(await OwnershipPage({ params: Promise.resolve({ groupDid: 'did:imajin:group' }) }));
    const expected = '/auth/login?next=' + encodeURIComponent('/auth/groups/did%3Aimajin%3Agroup/ownership');
    expect(screen.getByRole('link').getAttribute('href')).toBe(expected);
  });
});
