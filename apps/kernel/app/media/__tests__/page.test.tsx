import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@imajin/auth';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), redirect: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  getSession: mocks.getSession,
  resolveActingDid: (session: Identity) => session.actingFor ?? session.actingAs ?? session.id,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/src/components/media/MediaPageClient', () => ({ MediaPageClient: () => null }));
import Page from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });
});

describe('standalone media page', () => {
  it('requires a session', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/login');
  });

  it.each([undefined, 'did:imajin:group'])('uses the validated effective DID (actingAs=%s)', async (actingAs) => {
    mocks.getSession.mockResolvedValue({ id: 'did:imajin:actor', scope: 'actor', tier: 'hard', actingAs });
    const page = await Page();
    expect(mocks.getSession).toHaveBeenCalledWith({ service: 'media' });
    expect(page.props.session.id).toBe(actingAs ?? 'did:imajin:actor');
  });
});
