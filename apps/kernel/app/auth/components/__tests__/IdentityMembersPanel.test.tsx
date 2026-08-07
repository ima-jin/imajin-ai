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
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

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
function installFetch(controllers: ControllerFixture[]) {
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/controllers')) {
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (url.includes('/auth/api/groups/')) {
      return { ok: true, status: 200, json: async () => ({ controllers }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function renderPanel(controllers: ControllerFixture[] = [controller()]) {
  const spy = installFetch(controllers);
  render(<IdentityMembersPanel groupDid={GROUP} />);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('member identity', () => {
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
