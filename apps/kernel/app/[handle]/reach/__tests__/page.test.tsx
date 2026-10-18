// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { card } from '@/src/components/reach/__tests__/fixture';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), notFound: vi.fn() }));
vi.mock('@/src/lib/auth/reach-discovery', () => ({ resolveReachDiscovery: mocks.resolve }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

import PublicReachPage, { dynamic } from '../page';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(card);
  mocks.notFound.mockImplementation(() => { throw new Error('NEXT_NOT_FOUND'); });
});

describe('PublicReachPage', () => {
  it('is dynamic so disabling the gate does not leave a static public page', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it.each(['alex', '@alex', 'did:imajin:public-person'])('resolves %s through the shared privacy boundary', async handle => {
    render(await PublicReachPage({ params: Promise.resolve({ handle }) }));
    expect(mocks.resolve).toHaveBeenCalledWith(handle);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reach Alex');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('returns notFound when the resolver suppresses a disabled or ineligible principal', async () => {
    mocks.resolve.mockResolvedValue(null);
    await expect(PublicReachPage({ params: Promise.resolve({ handle: 'disabled' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(screen.queryByRole('main')).toBeNull();
  });
});
