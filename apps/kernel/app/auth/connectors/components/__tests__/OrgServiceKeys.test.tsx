// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrgServiceKeys from '../OrgServiceKeys';

const orgDid = 'did:imajin:artifact';
const memberDid = 'did:imajin:member';
const actorDid = 'did:imajin:admin';
const loadedAt = '2026-11-02T21:00:00.000Z';
const keyEndpoint = '/connections/api/org-held/anthropic';
const grantsEndpoint = `${keyEndpoint}/grants`;
const metadata = () => ({ provider: 'anthropic', status: 'loaded', loadedByDid: actorDid, loadedAt });
const member = (controllerDid: string, role = 'member') => ({
  controllerDid, role, name: controllerDid === memberDid ? 'Ryan' : 'Admin', handle: null,
  scope: 'actor', subtype: null, allowedServices: null,
});
function fixture(role = 'owner') {
  return {
    groupDid: orgDid, scope: 'business', name: 'Artifact', handle: 'artifact', viewerDid: actorDid, viewerRole: role,
    controllers: [
      member(actorDid, role), member(memberDid),
      { ...member('did:imajin:agent', 'agent'), subtype: 'agent' },
    ],
  };
}
function keyChange(method: string | undefined) {
  if (method === 'POST') return Response.json(metadata(), { status: 201 });
  if (method === 'DELETE') return Response.json({ revoked: true });
  return Response.json({});
}
function transport(options: { loaded?: boolean; role?: string; group?: ReturnType<typeof fixture>; readStatus?: number } = {}) {
  let loaded = options.loaded ?? true;
  let granted = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/auth/api/groups/')) return Response.json(options.group ?? fixture(options.role));
    if (url === '/auth/api/org-connections') return Response.json({ connections: [], suspensions: [], events: [] });
    if (url === '/connections/api/org-held' || url.startsWith('/connections/api/org-held/status?')) {
      const row = url === '/connections/api/org-held' ? metadata() : { provider: 'anthropic', status: 'loaded', loadedAt };
      return Response.json({ connections: loaded ? [row] : [] }, { status: options.readStatus ?? 200 });
    }
    if (url === keyEndpoint) {
      loaded = init?.method === 'POST';
      return keyChange(init?.method);
    }
    if (url === grantsEndpoint) {
      if (init?.method === 'POST') granted = true;
      if (init?.method === 'DELETE') granted = false;
      return Response.json({ grants: granted ? [{ memberDid }] : [] });
    }
    return Response.json({ grants: [] });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function panel(humanSession = true) {
  render(<OrgServiceKeys orgDid={orgDid} humanSession={humanSession} />);
  return within(await screen.findByRole('article', { name: 'Anthropic Claude org service key' }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('org service-key cards', () => {
  it('shows org identity, loaded provenance, stable grant anchor and existing suspend controls', async () => {
    const fetch = transport();
    const card = await panel();
    expect(screen.getByText(/Keys held by Artifact/)).toBeDefined();
    expect(card.getByText('Loaded')).toBeDefined();
    expect(card.getByText(`Loaded by ${actorDid}`)).toBeDefined();
    expect(card.getByText(loadedAt).getAttribute('datetime')).toBe(loadedAt);
    expect(card.getByRole('region', { name: 'Anthropic Claude member grants' }).id).toBe('org-connector-anthropic-grants');
    expect(card.getByText(/without a member grant/)).toBeDefined();
    expect(card.queryByText('did:imajin:agent')).toBeNull();
    expect(screen.getByRole('region', { name: 'Organization external connections' })).toBeDefined();
    for (const [, init] of fetch.mock.calls) {
      if (init?.headers) expect(init.headers).toMatchObject({ 'X-Acting-As': orgDid });
    }
  });

  it('loads, replaces and removes a key without retaining or rendering the submitted value', async () => {
    const fetch = transport({ loaded: false });
    const card = await panel();
    const generatedValue = crypto.randomUUID();
    const input = card.getByLabelText(/Service key \(write-only\)/) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');
    fireEvent.change(input, { target: { value: generatedValue } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');
    await card.findByText('Loaded');
    expect(document.body.textContent).not.toContain(generatedValue);
    const replacement = card.getByLabelText(/Replacement service key/) as HTMLInputElement;
    fireEvent.change(replacement, { target: { value: crypto.randomUUID() } });
    fireEvent.submit(replacement.closest('form')!);
    await waitFor(() => expect((card.getByRole('button', { name: 'Replace key' }) as HTMLButtonElement).disabled).toBe(false));
    expect(replacement.value).toBe('');
    fireEvent.click(card.getByRole('button', { name: 'Remove key' }));
    await card.findByText('Not loaded — re-load here');
    expect(fetch.mock.calls.filter(([url, init]) => url === keyEndpoint && init?.method).map(([, init]) => init?.method))
      .toEqual(['POST', 'POST', 'DELETE']);
  });

  it.each(['', ' ', 'has space', '\n', 'é', 'a'.repeat(4097)])('rejects invalid key input %# without a request', async value => {
    const fetch = transport({ loaded: false });
    const card = await panel();
    const input = card.getByLabelText(/Service key \(write-only\)/) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest('form')!);
    expect(card.getByRole('alert').textContent).toContain('1–4096');
    expect(fetch.mock.calls.some(([url, init]) => url === keyEndpoint && init?.method === 'POST')).toBe(false);
  });

  it.each([400, 403, 409, 503])('clears the key and never echoes a response error (%i)', async status => {
    const fetch = transport({ loaded: false });
    const card = await panel();
    const value = crypto.randomUUID();
    const log = vi.spyOn(console, 'error');
    fetch.mockResolvedValueOnce(Response.json({ error: value }, { status }));
    const input = card.getByLabelText(/Service key \(write-only\)/) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');
    await card.findByRole('alert');
    expect(within(card.getByRole('region', { name: 'Anthropic Claude org custody' })).getByRole('status').textContent).toContain('unavailable');
    expect(document.body.textContent).not.toContain(value);
    expect(log).not.toHaveBeenCalled();
  });

  it('clears a key after a network rejection, with no credential error echo', async () => {
    const fetch = transport({ loaded: false });
    const card = await panel();
    fetch.mockRejectedValueOnce(new Error(crypto.randomUUID()));
    const input = card.getByLabelText(/Service key \(write-only\)/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: crypto.randomUUID() } });
    fireEvent.submit(input.closest('form')!);
    await card.findByRole('alert');
    expect(input.value).toBe('');
  });

  it.each(['member', 'maintainer', 'agent'])('hides all mutations for non-admin %s', async role => {
    const fetch = transport({ role, readStatus: 403 });
    const card = await panel();
    expect(card.getByText('Read-only')).toBeDefined();
    expect(card.queryByRole('button')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url === `/connections/api/org-held/status?orgDid=${encodeURIComponent(orgDid)}`)).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url === '/connections/api/org-held' || url.endsWith('/grants'))).toBe(false);
    expect(card.queryByLabelText(/write-only/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Organization external connections' })).toBeNull();
    expect(fetch.mock.calls.some(([, init]) => init?.method)).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/grants'))).toBe(false);
  });

  it('renders member-readable loaded status with no loaded-by DID and never calls admin reads or grants', async () => {
    const fetch = transport({ role: 'member' });
    const card = await panel();
    expect(card.getByText('Loaded')).toBeDefined();
    expect(card.getByText(loadedAt)).toBeDefined();
    expect(card.queryByText(/Loaded by/)).toBeNull();
    expect(card.queryByRole('button')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url === `/connections/api/org-held/status?orgDid=${encodeURIComponent(orgDid)}`)).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url === '/connections/api/org-held' || url.endsWith('/grants'))).toBe(false);
  });

  it.each(['agent-session', 'service-restricted', 'missing-viewer'])('fails closed for %s', async boundary => {
    const group = fixture();
    if (boundary === 'service-restricted') Object.assign(group.controllers[0], { allowedServices: ['profile'] });
    if (boundary === 'missing-viewer') group.viewerDid = 'did:imajin:unknown';
    transport({ group });
    const card = await panel(boundary !== 'agent-session');
    expect(card.queryByRole('button')).toBeNull();
  });

  it.each([401, 503])('does not expose controls after group read failure %i', async status => {
    const fetch = transport();
    fetch.mockResolvedValueOnce(Response.json({}, { status }));
    render(<OrgServiceKeys orgDid={orgDid} humanSession />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('lets an ordinary member read verified status even when group act-as is forbidden', async () => {
    const fetch = transport({ role: 'member' });
    fetch.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    const card = await panel();
    expect(card.getByText('Loaded')).toBeDefined();
    expect(card.getByText('Read-only')).toBeDefined();
    expect(card.queryByRole('button')).toBeNull();
    expect(card.queryByText(/Loaded by/)).toBeNull();
    expect(screen.getByText(new RegExp(`Keys held by ${orgDid}`))).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => url === '/connections/api/org-held' || url.endsWith('/grants'))).toBe(false);
  });
  it('shows no cards or controls when group act-as and membership status are both denied', async () => {
    const fetch = transport({ role: 'member', readStatus: 403 });
    fetch.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    render(<OrgServiceKeys orgDid={orgDid} humanSession />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['wrong-org', 'actor-scope'])('rejects mismatched group context: %s', async boundary => {
    const group = fixture();
    if (boundary === 'wrong-org') group.groupDid = 'did:imajin:other';
    else group.scope = 'actor';
    transport({ group });
    render(<OrgServiceKeys orgDid={orgDid} humanSession />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('article')).toBeNull();
  });
});

describe('per-provider human-member grants', () => {
  it('requires a reason, grants and revokes via the existing API with authoritative reloads', async () => {
    const fetch = transport();
    const card = await panel();
    const grant = await card.findByRole('button', { name: 'Grant Anthropic Claude for Ryan' });
    expect((grant as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(card.getByLabelText(/Grant\/revoke reason/), { target: { value: ' Org work ' } });
    await waitFor(() => expect((grant as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(grant);
    fireEvent.click(await card.findByRole('button', { name: 'Revoke Anthropic Claude for Ryan' }));
    await card.findByRole('button', { name: 'Grant Anthropic Claude for Ryan' });
    const changes = fetch.mock.calls.filter(([url, init]) => url === grantsEndpoint && init?.method);
    expect(changes.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
    for (const [, init] of changes) {
      expect(JSON.parse(String(init?.body))).toEqual({ memberDid, reason: 'Org work' });
      expect(init?.headers).toMatchObject({ 'X-Acting-As': orgDid });
    }
  });

  it.each([' ', 'a'.repeat(501)])('rejects invalid grant reason %#', async reason => {
    const fetch = transport();
    const card = await panel();
    const grant = await card.findByRole('button', { name: 'Grant Anthropic Claude for Ryan' });
    fireEvent.change(card.getByLabelText(/Grant\/revoke reason/), { target: { value: reason } });
    expect((grant as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(grant);
    expect(fetch.mock.calls.some(([url, init]) => url === grantsEndpoint && init?.method)).toBe(false);
  });

  it('disables a new grant without a loaded key', async () => {
    transport({ loaded: false });
    const card = await panel();
    const grant = await card.findByRole('button', { name: 'Grant Anthropic Claude for Ryan' });
    fireEvent.change(card.getByLabelText(/Grant\/revoke reason/), { target: { value: 'Org work' } });
    expect((grant as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['loadedByDid', 'loadedAt'])('never claims loaded when legacy metadata lacks %s', async field => {
    const fetch = transport();
    const legacy = { ...metadata(), [field]: null };
    fetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/auth/api/groups/')) return Response.json(fixture());
      if (url === '/connections/api/org-held') return Response.json({ connections: [legacy] });
      return Response.json({ grants: [], connections: [], events: [], suspensions: [] });
    });
    const card = await panel();
    const custody = within(card.getByRole('region', { name: 'Anthropic Claude org custody' }));
    expect(custody.getByText('Not loaded — re-load here')).toBeDefined();
    expect(card.queryByText('Loaded')).toBeNull();
    expect(card.getByRole('button', { name: 'Load key' })).toBeDefined();
  });

  it.each([403, 503])('does not claim a failed mutation changed grant state (%i)', async status => {
    const fetch = transport();
    const card = await panel();
    const grant = await card.findByRole('button', { name: 'Grant Anthropic Claude for Ryan' });
    fireEvent.change(card.getByLabelText(/Grant\/revoke reason/), { target: { value: 'Org work' } });
    fetch.mockResolvedValueOnce(Response.json({}, { status }));
    fireEvent.click(grant);
    await card.findByRole('alert');
    expect(card.queryByRole('button', { name: 'Revoke Anthropic Claude for Ryan' })).toBeNull();
    expect((card.getByRole('button', { name: 'Grant Anthropic Claude for Ryan' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
