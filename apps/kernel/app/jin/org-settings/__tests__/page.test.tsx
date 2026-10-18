// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_SENDERS } from '@/src/lib/mail/types';
import OrgSettingsPage from '../page';
import { SenderForm } from '../sender-form';

const group: { groupDid: string; role: string; scope: string; name: string | null; handle: string | null } = { groupDid: 'did:imajin:org', role: 'owner', scope: 'business', name: 'Example', handle: 'example' };
const sender = { ownerDid: group.groupDid, purpose: 'signin' as const, appDid: '', domain: 'example.org', localPart: 'login', displayName: 'Example Login', replyTo: 'help@example.org' };
const settings = { senders: [sender], defaults: DEFAULT_SENDERS, readiness: { 'example.org': false } };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function loaded(groups = [group], data = settings) {
  const fetchSpy = vi.fn().mockResolvedValueOnce(json(groups)).mockResolvedValueOnce(json(data));
  vi.stubGlobal('fetch', fetchSpy);
  render(<OrgSettingsPage />);
  await screen.findByRole('form', { name: 'signin sender' });
  return fetchSpy;
}

describe('organization sender settings page', () => {
  it('loads controllable groups and renders all four fixed purpose forms and fallback warning', async () => {
    const fetchSpy = await loaded([
      group,
      { ...group, groupDid: 'not-admin', role: 'member', name: 'Hidden member' },
      { ...group, groupDid: 'not-group', scope: 'actor', name: 'Hidden actor' },
    ]);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, '/auth/api/groups', { credentials: 'include', cache: 'no-store' });
    expect(fetchSpy).toHaveBeenNthCalledWith(2, `/jin/api/orgs/${encodeURIComponent(group.groupDid)}/mail-senders`, { credentials: 'include', cache: 'no-store' });
    expect(screen.getAllByRole('form')).toHaveLength(4);
    expect(screen.queryByRole('option', { name: /Hidden/ })).toBeNull();
    expect(screen.getByText(/Saving an address does not verify it/)).toBeTruthy();
    const form = within(screen.getByRole('form', { name: 'signin sender' }));
    expect((form.getByLabelText('Domain') as HTMLInputElement).value).toBe('example.org');
    expect((form.getByLabelText('Local part') as HTMLInputElement).value).toBe('login');
    expect((form.getByLabelText('Display name') as HTMLInputElement).value).toBe('Example Login');
    expect((form.getByLabelText('Reply-to (optional)') as HTMLInputElement).value).toBe('help@example.org');
    expect(screen.getByRole('link', { name: 'Back to /jin' }).getAttribute('href')).toBe('/jin');
  });

  it('switches organizations, resets app context, and uses handle or DID for unnamed groups', async () => {
    const second = { ...group, groupDid: 'did:imajin:second', role: 'admin', scope: 'community', name: null };
    const third = { ...second, groupDid: 'did:imajin:third', handle: null, scope: 'family' };
    const fetchSpy = await loaded([group, second, third]);
    expect(screen.getByRole('option', { name: 'did:imajin:third' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: 'did:imajin:app' } });
    fetchSpy.mockResolvedValueOnce(json({ ...settings, senders: [] }));
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: second.groupDid } });
    await screen.findByRole('form', { name: 'signin sender' });
    expect(fetchSpy).toHaveBeenLastCalledWith(`/jin/api/orgs/${encodeURIComponent(second.groupDid)}/mail-senders`, expect.anything());
    expect((screen.getByLabelText('App override DID (optional)') as HTMLInputElement).value).toBe('');
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('');
  });

  it('loads existing app override separately and returns to the owner default', async () => {
    await loaded([group], { ...settings, senders: [sender, { ...sender, appDid: 'did:imajin:app', domain: 'app.example.org' }] });
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: 'did:imajin:app' } });
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('app.example.org');
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: '' } });
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('example.org');
  });

  it('retains saved values when switching away from and back to an app context', async () => {
    const fetchSpy = await loaded();
    fetchSpy.mockResolvedValue(json({ ok: true }));
    const form = within(screen.getByRole('form', { name: 'signin sender' }));
    fireEvent.change(form.getByLabelText('Domain'), { target: { value: 'changed.org' } });
    fireEvent.submit(screen.getByRole('form', { name: 'signin sender' }));
    await screen.findByRole('status');
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: 'did:imajin:app' } });
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: '' } });
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('changed.org');
  });

  it('adds app override without replacing owner settings and saves optional reply-to as null', async () => {
    const fetchSpy = await loaded();
    fetchSpy.mockResolvedValue(json({ ok: true }));
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: 'did:imajin:app' } });
    const form = within(screen.getByRole('form', { name: 'signin sender' }));
    fireEvent.change(form.getByLabelText('Domain'), { target: { value: 'app.org' } });
    fireEvent.change(form.getByLabelText('Display name'), { target: { value: 'App' } });
    fireEvent.submit(screen.getByRole('form', { name: 'signin sender' }));
    await screen.findByRole('status');
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: '' } });
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('example.org');
    fireEvent.change(screen.getByLabelText('App override DID (optional)'), { target: { value: 'did:imajin:app' } });
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('app.org');
  });

  it('ignores an in-flight save from a previously selected organization', async () => {
    const second = { ...group, groupDid: 'did:imajin:second', name: 'Second' };
    const fetchSpy = await loaded([group, second]);
    let resolveSave!: (value: unknown) => void;
    fetchSpy.mockReturnValueOnce(new Promise(done => { resolveSave = done; }))
      .mockResolvedValueOnce(json({ ...settings, senders: [] }));
    fireEvent.submit(screen.getByRole('form', { name: 'signin sender' }));
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: second.groupDid } });
    await screen.findByRole('form', { name: 'signin sender' });
    resolveSave(json({ ok: true }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('');
  });

  it('shows no controllable organizations rather than an editable form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])));
    render(<OrgSettingsPage />);
    expect(screen.getByRole('status').textContent).toContain('Loading organizations');
    await screen.findByText(/No organizations you own/);
    expect(screen.queryByRole('form')).toBeNull();
  });

  it.each([401, 500])('reports group load failure %i', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)));
    render(<OrgSettingsPage />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Unable to load organizations');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it.each([403, 500])('reports settings access/load failure %i without forms', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json([group])).mockResolvedValueOnce(json({}, status)));
    render(<OrgSettingsPage />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(status === 403 ? 'Access denied' : 'Unable to load settings');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('ignores a late organization result after unmount', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(done => { resolve = done; })));
    const view = render(<OrgSettingsPage />);
    view.unmount();
    resolve(json([group]));
    await Promise.resolve();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('does not overwrite the latest organization with an earlier response', async () => {
    let resolveOld!: (value: unknown) => void;
    const second = { ...group, groupDid: 'did:imajin:second', name: 'Second' };
    const fetchSpy = vi.fn().mockResolvedValueOnce(json([group, second]))
      .mockReturnValueOnce(new Promise(done => { resolveOld = done; }))
      .mockResolvedValueOnce(json({ ...settings, senders: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    render(<OrgSettingsPage />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: second.groupDid } });
    await screen.findByRole('form', { name: 'signin sender' });
    resolveOld(json(settings));
    await Promise.resolve();
    expect((within(screen.getByRole('form', { name: 'signin sender' })).getByLabelText('Domain') as HTMLInputElement).value).toBe('');
  });
});

describe('fixed purpose sender form', () => {
  function form(appDid = '') {
    return render(<SenderForm ownerDid={group.groupDid} appDid={appDid} purpose="signin" settings={settings} />);
  }

  it('saves changed fields with fixed purpose and optional app override, never readiness', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    form('did:imajin:app');
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'mail.example.org' } });
    fireEvent.change(screen.getByLabelText('Local part'), { target: { value: 'hello' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText('Reply-to (optional)'), { target: { value: 'reply@example.org' } });
    fireEvent.submit(screen.getByRole('form'));
    await screen.findByRole('status');
    expect(fetchSpy).toHaveBeenCalledWith(`/jin/api/orgs/${encodeURIComponent(group.groupDid)}/mail-senders`, expect.objectContaining({ method: 'PUT', credentials: 'include' }));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      purpose: 'signin', appDid: 'did:imajin:app', domain: 'mail.example.org', localPart: 'hello', displayName: 'Hello', replyTo: 'reply@example.org',
    });
    expect(screen.getByRole('status').textContent).toContain('Saved.');
  });

  it('disables duplicate submits while saving and persists null reply-to', async () => {
    let resolve!: (value: unknown) => void;
    const fetchSpy = vi.fn().mockReturnValue(new Promise(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetchSpy);
    form();
    fireEvent.change(screen.getByLabelText('Reply-to (optional)'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('form'));
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).replyTo).toBeNull();
    resolve(json({ ok: true }));
    await screen.findByRole('status');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([403, 400, 500])('reports save failure %i and permits retry', async status => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    form();
    fireEvent.submit(screen.getByRole('form'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(status === 403 ? 'Access denied' : 'Unable to save');
    fireEvent.submit(screen.getByRole('form'));
    await screen.findByRole('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([new Error('Network unavailable'), 'unknown rejection'])('reports network failures %s', async error => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    form();
    fireEvent.submit(screen.getByRole('form'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(error instanceof Error ? 'Network unavailable' : 'Unable to save');
  });

  it('reports verified state only from server readiness and not a save', () => {
    render(<SenderForm ownerDid={group.groupDid} appDid="" purpose="signin" settings={{ ...settings, readiness: { 'example.org': true } }} />);
    expect(screen.getByText('Domain verified for mail.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'unknown.org' } });
    expect(screen.getByText('Domain not verified — fallback active.')).toBeTruthy();
  });
});
