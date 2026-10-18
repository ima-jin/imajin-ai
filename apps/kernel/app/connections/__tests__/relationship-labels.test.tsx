// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConnectionsPage from '../page';
import { RelationshipEditor, type RelationshipLabel } from '../relationship-controls';

const fixtures = [
  { did: 'did:imajin:client', name: 'Client Co', relationshipLabel: 'client' as const },
  { did: 'did:imajin:vendor', name: 'Vendor Co', relationshipLabel: 'vendor' as const },
  { did: 'did:imajin:partner', name: 'Partner Co', relationshipLabel: 'partner' as const },
  { did: 'did:imajin:other', name: 'Other Co', relationshipLabel: 'other' as const },
  { did: 'did:imajin:unset', name: 'Unset Co', relationshipLabel: null },
].map(connection => ({ ...connection, connectedAt: '2026-01-01T00:00:00Z' }));

type ListData = { connections: typeof fixtures; canManageRelationshipLabels?: boolean };
let data: ListData = { connections: fixtures, canManageRelationshipLabels: true };
const mutate = vi.fn((update: (current: ListData) => ListData) => { data = update(data); });

vi.mock('../context/IdentityContext', () => ({
  useIdentity: () => ({ did: 'did:imajin:org', isLoggedIn: true, loading: false }),
}));
vi.mock('swr', () => ({
  default: (key: string) => key === '/connections/api/connections'
    ? { data, mutate } : { data: undefined, mutate: vi.fn() },
}));
vi.mock('../invitations-tab', () => ({ default: () => null }));
vi.mock('@imajin/ui', () => ({ useToast: () => ({ toast: { error: vi.fn() } }) }));
vi.mock('@imajin/config', () => ({ buildPublicUrl: (service: string) => `https://${service}.example` }));

afterEach(() => {
  cleanup();
  data = { connections: fixtures, canManageRelationshipLabels: true };
  mutate.mockClear();
  vi.unstubAllGlobals();
});

describe('connections relationship permissions and filtering', () => {
  it.each([false, undefined])('shows labels without editors when permission is %s', permission => {
    data = { connections: fixtures, canManageRelationshipLabels: permission };
    render(<ConnectionsPage />);
    expect(screen.getByText('client', { selector: 'span' })).toBeDefined();
    expect(screen.getByText('vendor', { selector: 'span' })).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Relationship for Client Co' })).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it.each(['client', 'vendor', 'partner', 'other', 'unset'])('filters the page by %s and restores all', label => {
    render(<ConnectionsPage />);
    const filter = screen.getByRole('combobox', { name: 'Relationship' });
    fireEvent.change(filter, { target: { value: label } });
    expect(screen.getAllByRole('button', { name: /Open profile for/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: `Open profile for ${fixtures.find(c => (c.relationshipLabel ?? 'unset') === label)!.name}` })).toBeDefined();
    fireEvent.change(filter, { target: { value: 'all' } });
    expect(screen.getAllByRole('button', { name: /Open profile for/ })).toHaveLength(5);
  });

  it('distinguishes a label with no matches from having no connections', () => {
    data = { connections: [fixtures[0]], canManageRelationshipLabels: false };
    render(<ConnectionsPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Relationship' }), { target: { value: 'vendor' } });
    expect(screen.getByText('No connections with this relationship label.')).toBeDefined();
    expect(screen.queryByText('No connections yet. Invite someone to get started!')).toBeNull();
  });
});

describe('connections relationship mutation', () => {
  it.each([
    [null, 'client'],
    ['client', 'vendor'],
    ['vendor', 'partner'],
    ['partner', 'other'],
    ['other', null],
  ] as Array<[RelationshipLabel | null, RelationshipLabel | null]>)('sets/changes/clears %s to %s only after PATCH succeeds', async (oldLabel, newLabel) => {
    data = { connections: [{ ...fixtures[0], relationshipLabel: oldLabel }], canManageRelationshipLabels: true };
    let finish!: (response: { ok: boolean }) => void;
    const fetchSpy = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchSpy);
    const { rerender } = render(<ConnectionsPage />);
    const select = screen.getByRole('combobox', { name: 'Relationship for Client Co' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: newLabel ?? '' } });
    expect(select.disabled).toBe(true);
    expect(select.value).toBe(oldLabel ?? '');
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith('/connections/api/connections/did%3Aimajin%3Aclient', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relationshipLabel: newLabel }),
    });
    finish({ ok: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(data.connections[0].relationshipLabel).toBe(newLabel);
    // Cache updates preserve other entries and the management permission.
    expect(data.canManageRelationshipLabels).toBe(true);
    rerender(<ConnectionsPage />);
    expect(select.value).toBe(newLabel ?? '');
    expect(select.disabled).toBe(false);
  });

  it.each(['http', 'network'])('keeps the old label and shows an error on %s failure, then allows retry', async kind => {
    const fetchSpy = vi.fn().mockImplementationOnce(async () => {
      if (kind === 'network') throw new TypeError('offline');
      return { ok: false };
    }).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    render(<ConnectionsPage />);
    const select = screen.getByRole('combobox', { name: 'Relationship for Client Co' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'vendor' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Failed to save relationship label/);
    expect(select.value).toBe('client');
    expect(select.disabled).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'partner' } });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(data.connections[1]).toEqual(fixtures[1]);
  });

  it('does not save an unchanged value', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<RelationshipEditor did="did:imajin:client" name="Client" value="client" canManage onSave={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'client' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
