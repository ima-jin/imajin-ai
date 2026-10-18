// @vitest-environment jsdom
/**
 * IdentityMembersPanel (#1680).
 *
 * The tab used to show truncated DIDs and a bare "Added 8/7/2026", which told a
 * controller nothing about who a member is or how they got there. What is
 * pinned here is the reading of that row — name, adder, provenance — plus the
 * `agent` role, which is what the X-Acting-For delegation check looks for, and
 * its service scoping, which is only enforced for agents.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

const GROUP = 'did:imajin:artifact';
const RYAN = 'did:imajin:88kPYWwv5YFrQwAteQQQQQQQQQQQQQQQQQ';
const JIN = 'did:imajin:jinQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';

// The real picker debounces a search request against /auth/api/search; the
// panel only ever consumes the DID it reports, so stand in a button that
// reports one directly.
vi.mock('../IdentityPicker', () => ({
  default: ({ onSelect }: { onSelect: (identity: { did: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ did: JIN })}>
      pick-identity
    </button>
  ),
}));

import IdentityMembersPanel from '../IdentityMembersPanel';

interface ControllerFixture {
  controllerDid: string;
  role: string;
  addedBy: string | null;
  addedVia: string | null;
  addedAt: string;
  allowedServices: string[] | null;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  subtype: string | null;
  addedByName: string | null;
  addedByHandle: string | null;
}

function controller(overrides: Partial<ControllerFixture> = {}): ControllerFixture {
  return {
    controllerDid: RYAN,
    role: 'owner',
    addedBy: RYAN,
    addedVia: 'direct',
    addedAt: '2026-08-07T12:00:00.000Z',
    allowedServices: null,
    name: 'Ryan Veteze',
    handle: 'veteze',
    avatarUrl: null,
    subtype: 'human',
    addedByName: 'Ryan Veteze',
    addedByHandle: 'veteze',
    ...overrides,
  };
}

/** Serves the group endpoint; every other request (config) 404s harmlessly. */
function installFetch(controllers: ControllerFixture[], viewerRole: string | null = 'owner', viewerDid = RYAN) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/auth/api/apps/directory') {
      return { ok: true, json: async () => ({
        apps: [{ slug: 'registry-only', name: 'Registry App', available: true }],
      }) } as unknown as Response;
    }
    if (url.endsWith('/controllers')) {
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (init?.method === 'PATCH') {
      const member = controllers.find((entry) => url.endsWith(encodeURIComponent(entry.controllerDid)));
      if (member) Object.assign(member, JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (url.includes('/auth/api/groups/')) {
      return { ok: true, status: 200, json: async () => ({ controllers, viewerRole, viewerDid }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function renderPanel(controllers: ControllerFixture[] = [controller()], viewerRole: string | null = 'owner', viewerDid = RYAN, scope = 'business') {
  const spy = installFetch(controllers, viewerRole, viewerDid);
  render(<IdentityMembersPanel groupDid={GROUP} scope={scope} />);
  await waitFor(() => expect(screen.queryByText('Loading members…')).toBeNull());
  return spy;
}

function roleSelect(): HTMLSelectElement {
  const select = document.querySelector('select');
  if (!select) throw new Error('no role select rendered');
  return select as HTMLSelectElement;
}

function roleOptions(): string[] {
  return Array.from(roleSelect().options).map((o) => o.value);
}

type FetchSpy = ReturnType<typeof installFetch>;

/** The JSON body of the add-controller POST, or null if it has not fired. */
function addControllerBody(spy: FetchSpy): Record<string, unknown> | null {
  const call = spy.mock.calls.find(([url]) => String(url).endsWith('/controllers'));
  if (!call) return null;
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inline member editing', () => {
  const jin = (overrides: Partial<ControllerFixture> = {}) => controller({
    controllerDid: JIN, role: 'member', name: 'Jin', handle: 'jin', ...overrides,
  });
  const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit Jin (@jin)' }));
  const editRole = () => screen.getByRole('combobox', { name: 'Member role' }) as HTMLSelectElement;
  const patchCalls = (spy: FetchSpy) => spy.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  const patchBody = (spy: FetchSpy) => JSON.parse(String(patchCalls(spy)[0]?.[1]?.body));
  it('dismisses the update status after five seconds', async () => {
    await renderPanel([jin()]);
    vi.useFakeTimers();
    edit();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByText('Member updated.')).toBeDefined();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByText('Member updated.')).toBeNull();
  });

  it('cancels its pending status timeout when the panel unmounts', async () => {
    await renderPanel([jin()]);
    vi.useFakeTimers();
    edit();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(5000); });
  });

  it.each([
    ['member', 'admin'],
    ['admin', 'maintainer'],
    ['maintainer', 'member'],
  ])('changes %s to %s and refreshes the member list', async (initial, next) => {
    const spy = await renderPanel([controller(), jin({ role: initial })]);
    edit();
    expect(editRole().value).toBe(initial);
    fireEvent.change(editRole(), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Member updated.')).toBeDefined());
    await waitFor(() => expect(screen.queryByText('Loading members…')).toBeNull());
    expect(patchBody(spy)).toEqual({ role: next, allowedServices: null });
    expect(patchCalls(spy)[0][0]).toBe(
      `http://localhost:3000/auth/api/groups/${encodeURIComponent(GROUP)}/controllers/${encodeURIComponent(JIN)}`,
    );
    expect(patchCalls(spy)[0][1]).toMatchObject({
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('initializes agent scope and saves kernel and registry service changes', async () => {
    const spy = await renderPanel([jin({ role: 'agent', allowedServices: ['media'] })]);
    edit();
    expect((screen.getByLabelText('Media') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Media'));
    fireEvent.click(screen.getByLabelText('Registry App'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchCalls(spy)).toHaveLength(1));
    expect(patchBody(spy)).toEqual({ role: 'agent', allowedServices: ['registry-only'] });
  });

  it('clears the service restriction when all services are deselected', async () => {
    const spy = await renderPanel([jin({ role: 'agent', allowedServices: ['media'] })]);
    edit();
    fireEvent.click(screen.getByLabelText('Media'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchCalls(spy)).toHaveLength(1));
    expect(patchBody(spy)).toEqual({ role: 'agent', allowedServices: null });
  });

  it('sends null scope on a human role even when the agent was scoped', async () => {
    const spy = await renderPanel([jin({ role: 'agent', allowedServices: ['media'] })]);
    edit();
    fireEvent.change(editRole(), { target: { value: 'member' } });
    expect(screen.queryByText('Restrict to specific services')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchCalls(spy)).toHaveLength(1));
    expect(patchBody(spy)).toEqual({ role: 'member', allowedServices: null });
  });

  it('discards unsaved role and scope changes on Cancel', async () => {
    const spy = await renderPanel([jin({ role: 'agent', allowedServices: ['media'] })]);
    edit();
    fireEvent.click(screen.getByLabelText('Media'));
    fireEvent.change(editRole(), { target: { value: 'maintainer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(patchCalls(spy)).toHaveLength(0);
    edit();
    expect(editRole().value).toBe('agent');
    expect((screen.getByLabelText('Media') as HTMLInputElement).checked).toBe(true);
  });

  it.each(['server', 'invalid-json', 'network'])('retains edits after %s failure and permits retry', async (failure) => {
    const spy = await renderPanel([jin()]);
    edit();
    fireEvent.change(editRole(), { target: { value: 'maintainer' } });
    spy.mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('offline');
      return {
        ok: false,
        json: async () => {
          if (failure === 'invalid-json') throw new Error('invalid JSON');
          return { error: 'Member changed; retry.' };
        },
      } as Response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const expected = failure === 'network' ? 'Network error. Please try again.'
      : failure === 'server' ? 'Member changed; retry.' : 'Failed to update member.';
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(expected));
    expect(editRole().value).toBe('maintainer');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Member updated.')).toBeDefined());
  });

  it('disables editor controls and removal while saving', async () => {
    const spy = await renderPanel([jin({ role: 'agent' })]);
    edit();
    let resolve!: (response: Response) => void;
    spy.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(document.querySelector('fieldset')?.disabled).toBe(true);
    expect((screen.getByTitle('Remove member') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDefined();
    resolve({ ok: true } as Response);
    await waitFor(() => expect(screen.getByText('Member updated.')).toBeDefined());
  });

  it('keeps owners immutable and routes ownership changes to the transfer flow', async () => {
    await renderPanel([controller(), jin()]);
    expect(screen.queryByRole('button', { name: 'Edit Ryan Veteze (@veteze)' })).toBeNull();
    expect(screen.getAllByTitle('Remove member')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'ownership transfer' }).getAttribute('href'))
      .toBe(`/auth/groups/${encodeURIComponent(GROUP)}/ownership`);
    edit();
    expect(Array.from(editRole().options).map((option) => option.value)).not.toContain('owner');
  });

  it('prevents admins from editing other admins, maintainers or agents or assigning admin', async () => {
    await renderPanel([controller(), jin(), controller({
      controllerDid: 'did:imajin:other-admin', role: 'admin', name: 'Other admin', handle: null,
    }), controller({
      controllerDid: 'did:imajin:maintainer', role: 'maintainer', name: 'Maintainer', handle: null,
    }), controller({
      controllerDid: 'did:imajin:agent', role: 'agent', name: 'Agent', handle: null,
    })], 'admin');
    expect(screen.queryByRole('button', { name: 'Edit Other admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Maintainer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Agent' })).toBeNull();
    edit();
    expect(Array.from(editRole().options).map((option) => option.value))
      .toEqual(['maintainer', 'member', 'agent']);
  });

  it('allows an admin to self-demote without reassigning admin', async () => {
    const spy = await renderPanel([jin({ role: 'admin' })], 'admin', JIN);
    edit();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editRole(), { target: { value: 'member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchCalls(spy)).toHaveLength(1));
    expect(patchBody(spy)).toEqual({ role: 'member', allowedServices: null });
  });

  it.each([null, 'member', 'maintainer', 'agent'])('hides editing for viewer role %s', async (viewerRole) => {
    await renderPanel([jin()], viewerRole);
    expect(screen.queryByRole('button', { name: 'Edit Jin (@jin)' })).toBeNull();
  });
});

describe('member identity', () => {
  it.each(['business', 'community', 'family'])('explains authority and roster access for %s identities', async (scope) => {
    await renderPanel(undefined, 'owner', RYAN, scope);
    expect(screen.getByText(/Members act for this organization and can see who's inside it/)).toBeDefined();
    expect(screen.getByText(/Clients, vendors and partners should be added as a connection instead/)).toBeDefined();
    const link = screen.getByRole('link', { name: 'Add a connection' });
    expect(link.getAttribute('href')).toBe('/connections?connect=1');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(localStorage.getItem('imajin:acting-as')).toBe(GROUP);
  });

  it('does not show org guardrail copy on personal identities', async () => {
    await renderPanel(undefined, 'owner', RYAN, 'actor');
    expect(screen.queryByRole('link', { name: 'Add a connection' })).toBeNull();
  });
  it('shows the resolved name and handle instead of the DID', async () => {
    await renderPanel();

    expect(screen.getByText('Ryan Veteze (@veteze)')).toBeDefined();
    expect(screen.queryByText(new RegExp(RYAN.slice(0, 20)))).toBeNull();
  });

  it('falls back to the handle when only a handle resolved', async () => {
    await renderPanel([controller({ name: null })]);

    expect(screen.getByText('@veteze')).toBeDefined();
  });

  it('falls back to a truncated DID when nothing resolved', async () => {
    await renderPanel([controller({ name: null, handle: null })]);

    expect(screen.getByText(`${RYAN.slice(0, 28)}…`)).toBeDefined();
  });

  it('keeps the full DID available as a title for copy/paste', async () => {
    await renderPanel();

    expect(screen.getByTitle(RYAN)).toBeDefined();
  });
});

describe('provenance', () => {
  it('names the adder, the route in, and the date', async () => {
    await renderPanel([
      controller({
        controllerDid: JIN,
        role: 'member',
        name: 'Jin',
        handle: 'jin',
        addedVia: 'direct',
      }),
    ]);

    expect(screen.getByText('Added by Ryan Veteze (@veteze)')).toBeDefined();
    expect(screen.getByText('direct')).toBeDefined();
    expect(screen.getByText('Aug 7, 2026')).toBeDefined();
  });

  it('explains the provenance value on hover', async () => {
    await renderPanel([controller({ addedVia: 'invite' })]);

    expect(screen.getByTitle('Arrived via an invite code')).toBeDefined();
  });

  it('omits the provenance chip when added_via is unknown', async () => {
    await renderPanel([controller({ addedVia: null })]);

    expect(screen.getByText('Added by Ryan Veteze (@veteze)')).toBeDefined();
    expect(screen.queryByText('direct')).toBeNull();
  });

  it('degrades to a bare "Added" when the adder cannot be resolved', async () => {
    await renderPanel([
      controller({ addedBy: null, addedByName: null, addedByHandle: null, addedVia: null }),
    ]);

    expect(screen.getByText('Added')).toBeDefined();
  });
});

describe('agent role', () => {
  it('offers registry-only apps for delegation without static rows', async () => {
    await renderPanel();
    fireEvent.change(roleSelect(), { target: { value: 'agent' } });
    expect(screen.getByLabelText('Registry App')).toBeDefined();
  });
  it('offers agent in the role dropdown', async () => {
    await renderPanel();

    expect(roleOptions()).toEqual(['admin', 'maintainer', 'member', 'agent']);
  });

  it('does not offer owner — ownership is not granted from this dropdown', async () => {
    await renderPanel();

    expect(roleOptions()).not.toContain('owner');
  });

  it('hides the service selector for non-agent roles', async () => {
    await renderPanel();

    expect(screen.queryByText('Restrict to specific services')).toBeNull();
  });

  it('reveals the service selector once agent is chosen', async () => {
    await renderPanel();

    fireEvent.change(roleSelect(), { target: { value: 'agent' } });

    expect(screen.getByText('Restrict to specific services')).toBeDefined();
    expect(screen.getByText(/may act across every service/)).toBeDefined();
  });

  it('sends the selected services with an agent membership', async () => {
    const spy = await renderPanel();

    fireEvent.change(roleSelect(), { target: { value: 'agent' } });
    fireEvent.click(screen.getByText('Media'));
    fireEvent.click(screen.getByText('pick-identity'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addControllerBody(spy)).not.toBeNull());
    expect(addControllerBody(spy)).toEqual({
      did: JIN,
      role: 'agent',
      allowedServices: ['media'],
    });
  });

  it('sends no service restriction for a non-agent role', async () => {
    const spy = await renderPanel();

    fireEvent.click(screen.getByText('pick-identity'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addControllerBody(spy)).not.toBeNull());
    expect(addControllerBody(spy)).toEqual({
      did: JIN,
      role: 'member',
      allowedServices: null,
    });
  });
});

describe('service scoping badge', () => {
  it('names a single scoped service on the member row', async () => {
    await renderPanel([
      controller({ controllerDid: JIN, role: 'agent', name: 'Jin', handle: 'jin', allowedServices: ['media'] }),
    ]);

    expect(screen.getByText('media')).toBeDefined();
  });

  it('counts multiple scoped services', async () => {
    await renderPanel([
      controller({
        controllerDid: JIN,
        role: 'agent',
        name: 'Jin',
        handle: 'jin',
        allowedServices: ['media', 'chat', 'pay'],
      }),
    ]);

    expect(screen.getByText('3 services')).toBeDefined();
    expect(screen.getByTitle('media, chat, pay')).toBeDefined();
  });
});
