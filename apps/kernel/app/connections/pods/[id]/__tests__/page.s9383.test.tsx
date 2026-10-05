// @vitest-environment jsdom
/**
 * PodDetailPage — fetchPod() calls (mount effect, after add member, after
 * remove member) are fired via fireAndForget (typescript:S9383). Behaviour
 * must be unchanged: each path still refetches the group.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import PodDetailPage from '../page';

const OWNER = 'did:imajin:owner';
const OTHER = 'did:imajin:other';

let identity = { did: OWNER as string | null, isLoggedIn: true, loading: false };

vi.mock('../../../context/IdentityContext', () => ({
  useIdentity: () => identity,
}));

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
  ConnectionPicker: ({ onSelect }: { onSelect: (c: { did: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ did: 'did:imajin:new' })}>
      pick-connection
    </button>
  ),
}));

// The kernel app runs on a React build that ships `use()`; the React 18.3 used by
// the unit-test toolchain does not, so provide a minimal synchronous stand-in
// that unwraps the pre-resolved params thenable built by `paramsFor` below.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, use: (p: { value: unknown }) => p.value };
});

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const podPayload = {
  pod: {
    id: 'p1',
    name: 'My Group',
    description: null,
    type: 'shared',
    visibility: 'private',
    ownerDid: OWNER,
    createdAt: '2026-01-01T00:00:00Z',
    memberCount: 2,
  },
  members: [
    { podId: 'p1', did: OWNER, role: 'owner', addedBy: null, joinedAt: '2026-01-01T00:00:00Z', removedAt: null, handle: 'owner', name: 'Owner' },
    { podId: 'p1', did: OTHER, role: 'member', addedBy: OWNER, joinedAt: '2026-01-02T00:00:00Z', removedAt: null, handle: 'other', name: 'Other' },
  ],
};

function installFetch() {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method && url === '/auth/api/groups/p1') {
      return { ok: true, json: async () => podPayload };
    }
    if (init?.method === 'POST' && url === '/auth/api/groups/p1/members') {
      return { ok: true, json: async () => ({}) };
    }
    if (init?.method === 'DELETE' && url === '/auth/api/groups/p1/members') {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function getCalls(spy: ReturnType<typeof installFetch>) {
  return spy.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method);
}

/** Pre-resolved thenable so React's `use()` does not suspend. */
function paramsFor(id: string) {
  const value = { id };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value }) as Promise<{ id: string }>;
}

async function renderPage() {
  await act(async () => {
    render(<PodDetailPage params={paramsFor('p1')} />);
  });
  await waitFor(() => expect(screen.getByText('My Group')).toBeDefined());
}

afterEach(() => {
  cleanup();
  identity = { did: OWNER, isLoggedIn: true, loading: false };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PodDetailPage fetchPod fire-and-forget sites', () => {
  it('fetches the group from the mount effect when logged in', async () => {
    const spy = installFetch();
    await renderPage();
    expect(getCalls(spy)).toHaveLength(1);
    expect(screen.getByText('Other')).toBeDefined();
  });

  it('does not fetch when not logged in', async () => {
    identity = { did: null, isLoggedIn: false, loading: false };
    const spy = installFetch();
    await act(async () => {
      render(<PodDetailPage params={paramsFor('p1')} />);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refetches the group after a member is added', async () => {
    const spy = installFetch();
    await renderPage();

    fireEvent.click(screen.getByText('+ Add Member'));
    fireEvent.click(screen.getByText('pick-connection'));

    await waitFor(() => expect(getCalls(spy)).toHaveLength(2));
    const post = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/auth/api/groups/p1/members');
    // add-member panel closes
    await waitFor(() => expect(screen.queryByText('pick-connection')).toBeNull());
  });

  it('refetches the group after a member is removed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const spy = installFetch();
    await renderPage();

    fireEvent.click(screen.getByTitle('Remove member'));

    await waitFor(() => expect(getCalls(spy)).toHaveLength(2));
    const del = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    expect(JSON.parse((del?.[1] as RequestInit).body as string)).toEqual({ did: OTHER });
  });

  it('shows the error state when the refetch fails (existing handling, nothing rejects)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await act(async () => {
      render(<PodDetailPage params={paramsFor('p1')} />);
    });
    await waitFor(() => expect(screen.getByText('Failed to load group.')).toBeDefined());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
