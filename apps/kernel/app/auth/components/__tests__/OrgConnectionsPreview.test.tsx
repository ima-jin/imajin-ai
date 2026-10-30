// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Preview from '@/app/dev/org-connections-preview/preview';
import Page from '@/app/dev/org-connections-preview/page';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('org connection development fixture', () => {
  it('uses real panel controls, restores transport, and renders simulated 403 without API authority', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const original = vi.fn().mockResolvedValue(Response.json({ fixture: true }));
    vi.stubGlobal('fetch', original);
    const view = render(Page());
    await screen.findByText('did:imajin:fixture-member');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Preview check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend connection' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume connection' }));
    await screen.findByRole('button', { name: 'Suspend connection' });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend service' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume service' }));
    await screen.findByRole('button', { name: 'Suspend service' });
    expect(screen.getAllByText(/by did:imajin:fixture-admin · Preview check/)).toHaveLength(4);
    await window.fetch('/unrelated');
    expect(original).toHaveBeenCalledWith('/unrelated', undefined);
    await window.fetch(new URL('https://fixture.test/unrelated'));
    await window.fetch(new Request('https://fixture.test/unrelated'));
    expect((await window.fetch('/auth/api/org-connections', { method: 'POST' })).status).toBe(400);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((await screen.findByRole('alert')).textContent).toContain('403');
    view.unmount();
    expect(window.fetch).toBe(original);
  });
  it('refuses production routing and never overrides transport outside development', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const original = vi.fn();
    vi.stubGlobal('fetch', original);
    expect(() => Page()).toThrow('not found');
    const view = render(<Preview />);
    expect(view.container.childElementCount).toBe(0);
    expect(window.fetch).toBe(original);
  });
});
