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
    ['missing', 'Set', 'set'],
    ['revoked', 'Set', 'set'],
    ['active', 'Rotate', 'rotate'],
  ])('submits %s operator input once, masked and immediately cleared', async (status, label, action) => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ apps: [{
      ...app, secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied', status, timeline: [] }],
    }] })).mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AppSecretsPanel />);
    const input = await screen.findByLabelText('New value for DATABASE_URL') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(screen.getByText(/DATABASE_URL/).parentElement?.textContent).toContain(status === 'active' ? 'set' : 'not set');
    fireEvent.change(input, { target: { value: 'OBVIOUSLY_FAKE_DATABASE_VALUE' } });
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(container.textContent).not.toContain('OBVIOUSLY_FAKE_DATABASE_VALUE');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      appDid: app.appDid, action, name: 'DATABASE_URL', value: 'OBVIOUSLY_FAKE_DATABASE_VALUE',
    });
    complete(Response.json({ status: 'pending', proposalId: 'fake-supplied' }));
    await screen.findByRole('link', { name: 'Review proposal' });
    expect(input.value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
  });
  it.each(['response', 'network', 'json'])('never renders supplied-value failures from %s', async (failure) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ apps: [{
      ...app, secrets: [{ name: 'SMTP_PASSWORD', kind: 'operator-supplied', status: 'missing', timeline: [] }],
    }] }));
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_PRIVATE_VALUE'));
    else if (failure === 'json') fetchMock.mockResolvedValueOnce({ json: () => { throw new Error('OBVIOUSLY_FAKE_PRIVATE_VALUE'); } });
    else fetchMock.mockResolvedValueOnce(Response.json({ error: 'OBVIOUSLY_FAKE_PRIVATE_VALUE' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AppSecretsPanel />);
    const input = await screen.findByLabelText('New value for SMTP_PASSWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'OBVIOUSLY_FAKE_PRIVATE_VALUE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await screen.findByText('App-secret proposal failed.');
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain('OBVIOUSLY_FAKE_PRIVATE_VALUE');
    expect(screen.queryByRole('link', { name: 'Review proposal' })).toBeNull();
  });
  it('shows only set state and last rotation for supplied secret lifecycle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ apps: [{
      ...app, secrets: [{ ...app.secrets[0], name: 'DATABASE_URL', kind: 'operator-supplied' }],
    }] })));
    render(<AppSecretsPanel />);
    const status = await screen.findByText(/DATABASE_URL/);
    expect(status.parentElement?.textContent).toContain('set · last rotated');
    expect(screen.queryByText(/signed by/)).toBeNull();
    expect(screen.queryByText(/minted ·/)).toBeNull();
  });
  it('offers no entry fields for an unclaimed app', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ apps: [{
      ...app, claimed: false, secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied', status: 'missing', timeline: [] }],
    }] })));
    render(<AppSecretsPanel />);
    await screen.findByText('unclaimed');
    expect(screen.queryByLabelText('New value for DATABASE_URL')).toBeNull();
  });
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
  it.each([
    "App 'fake-app' manifest unreadable (HTTP 404)",
    "App 'fake-app' manifest invalid",
  ])('shows the names-only Sync error instead of a pending or empty approval: %s', async (error) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ apps: [app] }))
      .mockResolvedValueOnce(Response.json({ error }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AppSecretsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync manifest secrets' }));
    expect(await screen.findByText(error)).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Review proposal' })).toBeNull();
    expect(screen.queryByText(/Proposal pending/)).toBeNull();
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
