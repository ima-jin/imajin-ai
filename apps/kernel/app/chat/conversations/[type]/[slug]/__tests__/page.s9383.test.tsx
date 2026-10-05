// @vitest-environment jsdom
/**
 * Group conversation detail page — S9383 floating-promise fixes (#2568).
 *
 * `handleNameSave()` (Enter in the rename input) and `loadConnections()`
 * ("+ Add member") are fired without being awaited; both now go through
 * `fireAndForget`. Both handle their own failures, so these tests pin the
 * unchanged behaviour (PATCH sent / connections fetched) rather than a
 * rejection path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ME = 'did:imajin:alice';
const CARLA = 'did:imajin:carol';

// A stable object reference, not a fresh literal per call — `identity` feeds
// dependency arrays (e.g. the members-fetch effect) that would otherwise
// re-run on every render and loop forever.
const identityState = { identity: { did: ME }, loading: false };

vi.mock('@/src/contexts/IdentityContext', () => ({
  useIdentity: () => identityState,
  LoginPrompt: () => <div>Sign In</div>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ type: 'group', slug: 'testgroup' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: Readonly<{ href: string; children: React.ReactNode; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
}));

vi.mock('@imajin/chat', () => ({
  Chat: () => null,
  ChatProvider: ({ children }: Readonly<{ children: React.ReactNode }>) => children,
  useDidNames: (dids: string[]) => {
    const map: Record<string, string> = {};
    for (const d of dids) if (d === CARLA) map[d] = 'Carol';
    return map;
  },
}));

const { default: ConversationPage } = await import('../page');

const DID = `did:imajin:group:testgroup`;

function installFetch() {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/chat/api/conversations/${encodeURIComponent(DID)}` && !init?.method) {
      return { ok: true, status: 200, json: async () => ({ conversation: {} }) } as unknown as Response;
    }
    if (url === `/chat/api/d/${encodeURIComponent(DID)}/members`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ members: [{ did: ME, role: 'owner' }], count: 1 }),
      } as unknown as Response;
    }
    if (url === 'https://connections.example/api/connections') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ connections: [{ did: CARLA, handle: 'carol' }] }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rename via Enter', () => {
  it('PATCHes the new name and shows it optimistically', async () => {
    const spy = installFetch();

    render(<ConversationPage />);

    fireEvent.click(await screen.findByTitle('Click to rename'));
    const input = screen.getByPlaceholderText('Untitled Group');
    fireEvent.change(input, { target: { value: 'Book Club' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Book Club')).toBeDefined());
    const patch = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch![0]).toBe(`/chat/api/conversations/${encodeURIComponent(DID)}`);
    expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ name: 'Book Club' });
  });
});

describe('add member', () => {
  it('loads the connections list when the picker opens', async () => {
    const spy = installFetch();

    render(<ConversationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /member/i }));
    fireEvent.click(await screen.findByText('+ Add member'));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('https://connections.example/api/connections', { credentials: 'include' }),
    );
    expect(await screen.findByText('Carol')).toBeDefined();
  });
});
