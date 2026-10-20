// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  redirect: vi.fn(() => { throw new Error('redirect'); }),
}));
vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../keys-panel', () => ({ KeysPanel: () => <div>Public-only rotation controls</div> }));

import AdminKeysPage, { dynamic } from '../page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('/admin/keys authorization', () => {
  it('requires admin authorization before rendering the controls', async () => {
    mocks.requireAdmin.mockResolvedValue(null);
    await expect(AdminKeysPage()).rejects.toThrow('redirect');
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith('/');
  });

  it('renders authorized controls dynamically', async () => {
    mocks.requireAdmin.mockResolvedValue({ did: 'did:imajin:admin' });
    render(await AdminKeysPage());
    expect(screen.getByRole('heading', { name: 'Node keys' })).toBeTruthy();
    expect(screen.getByText('Public-only rotation controls')).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(dynamic).toBe('force-dynamic');
  });
});
