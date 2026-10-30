// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OrgConnectionsPanel, { type OrgConnectionsData } from '../OrgConnectionsPanel';

const fixture = (): OrgConnectionsData => ({
  connections: [{ id: 'conn_fixture', memberDid: 'did:imajin:member', provider: 'external-mcp-postman', slot: 'primary', status: 'active' }],
  suspensions: [],
  events: [],
});
function transport(data = fixture()) {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const memberDid = body.connectionId ? 'did:imajin:member' : '';
      const provider = body.provider ?? 'external-mcp-postman';
      const slot = memberDid ? 'primary' : '';
      const existing = data.suspensions.find(row => row.memberDid === memberDid && row.provider === provider);
      const suspendedAt = body.action === 'suspend' ? new Date().toISOString() : null;
      if (existing) existing.suspendedAt = suspendedAt;
      else data.suspensions.push({ orgDid: 'did:imajin:org', memberDid, provider, slot, suspendedAt });
      data.events.push({ id: `event_${data.events.length}`, memberDid: memberDid || null, provider,
        actorDid: 'did:imajin:admin', action: body.action, reason: body.reason, createdAt: new Date().toISOString() });
      return Response.json({ ok: true });
    }
    return Response.json(data);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const panel = () => render(<OrgConnectionsPanel groupDid="did:imajin:org" />);
const reason = () => fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Policy review' } });

describe('org connection control', () => {
  it('renders, requires a reason, suspends/resumes a member and shows actor/reason history', async () => {
    const fetch = transport(); panel();
    const suspend = await screen.findByRole('button', { name: 'Suspend connection' });
    expect((suspend as HTMLButtonElement).disabled).toBe(true);
    reason(); fireEvent.click(suspend);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume connection' }));
    await screen.findByRole('button', { name: 'Suspend connection' });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([
        { action: 'suspend', reason: 'Policy review', connectionId: 'conn_fixture' },
        { action: 'resume', reason: 'Policy review', connectionId: 'conn_fixture' },
      ]);
    expect(screen.getAllByText(/by did:imajin:admin · Policy review/)).toHaveLength(2);
  });
  it('suspends/resumes the service independently and retains individual suspension', async () => {
    transport(); panel(); await screen.findByText('did:imajin:member'); reason();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend connection' }));
    await screen.findByRole('button', { name: 'Resume connection' });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend service' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume service' }));
    await screen.findByRole('button', { name: 'Suspend service' });
    expect(screen.getByRole('button', { name: 'Resume connection' })).toBeDefined();
  });
  it('shows 403 on read without controls, and on mutation without optimistic state changes', async () => {
    const fetch = transport();
    fetch.mockResolvedValueOnce(Response.json({ error: 'Forbidden' }, { status: 403 }));
    const view = panel();
    expect((await screen.findByRole('alert')).textContent).toContain('403');
    expect(screen.queryByRole('button', { name: 'Suspend connection' })).toBeNull();
    view.unmount();
    panel(); await screen.findByText('did:imajin:member'); reason();
    fetch.mockResolvedValueOnce(Response.json({ error: 'Forbidden' }, { status: 403 }));
    fireEvent.click(screen.getByRole('button', { name: 'Suspend connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('403');
    expect(screen.queryByRole('button', { name: 'Resume connection' })).toBeNull();
  });
  it('renders an empty state with no service action enabled and handles non-403 load failure', async () => {
    transport({ connections: [], suspensions: [], events: [] }); panel();
    await screen.findByText('No org-tagged connections.');
    expect((screen.getByRole('button', { name: 'Suspend service' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    panel(); expect((await screen.findByRole('alert')).textContent).toContain('Unable to load');
  });
  it('retains a suspended service with no current connections and handles mutation failures', async () => {
    const data = fixture();
    data.suspensions.push({ orgDid: 'did:imajin:org', provider: 'future-service', memberDid: '', slot: '', suspendedAt: new Date().toISOString() });
    const fetch = transport(data); panel(); await screen.findByText('did:imajin:member');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'future-service' } });
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDefined();
    reason();
    fetch.mockRejectedValueOnce(new Error('Network unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Resume service' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Network unavailable');
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume service' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Unable to change suspension.'));
  });
});
