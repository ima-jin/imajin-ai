// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppSecretsPanel } from '../app-secrets-panel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const app = {
  appDid: 'did:imajin:fake-app', slug: 'fake-app', name: 'Fake app', active: true, claimed: true,
  secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B', status: 'active', timeline: [
    { phase: 'minted', at: '2026-10-14T00:00:00Z', operatorDid: 'did:imajin:fake-operator', via: 'fake-proposal' },
    { phase: 'granted', at: '2026-10-14T00:00:01Z' },
    { phase: 'fetched', at: '2026-10-14T00:00:02Z' },
    { phase: 'rotated', at: '2026-10-14T00:00:03Z' },
  ] }],
};
describe('AppSecretsPanel', () => {
  it.each([
    null, {}, { apps: null }, { apps: 'bad' }, { apps: [null] },
    { apps: [{ ...app, secrets: undefined }] },
    { apps: [{ ...app, claimed: 'true' }] },
    { apps: [{ ...app, secrets: [{ ...app.secrets[0], timeline: null }] }] },
    { apps: [{ ...app, secrets: [{ ...app.secrets[0], timeline: [{ phase: 'minted', at: {} }] }] }] },
  ])('fails closed on malformed metadata without throwing or offering controls', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AppSecretsPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('renders names/recipes and signed lifecycle, and Rotate only proposes without a reveal', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ apps: [app] }))
      .mockResolvedValueOnce(Response.json({ status: 'pending', proposalId: 'fake-proposal-2' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AppSecretsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ appDid: app.appDid, action: 'rotate', name: 'SESSION_SECRET' });
    expect(await screen.findByText(/Proposal pending/)).toBeDefined();
    expect(screen.getByText(/signed by/).textContent).toContain('did:imajin:fake-operator');
    expect(screen.getByText(/signed by/).textContent).toContain('fake-proposal');
    for (const phase of ['minted', 'granted', 'fetched', 'rotated']) expect(screen.getByText(new RegExp(phase))).toBeDefined();
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/next boot/)).toBeDefined();
  });
  it('stages sync with no client-provided declarations and refreshes approvals', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ apps: [app] }))
      .mockResolvedValueOnce(Response.json({ proposalId: 'fake-sync' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AppSecretsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync manifest secrets' }));
    await screen.findByRole('link', { name: 'Review proposal' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ appDid: app.appDid, action: 'sync' });
  });
  it('shows unclaimed provisions but offers no secret mutation controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ apps: [{ ...app, claimed: false }] })));
    render(<AppSecretsPanel />);
    await screen.findByText('unclaimed');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('renders nothing for nonoperators', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AppSecretsPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
