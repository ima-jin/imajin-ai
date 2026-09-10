// @vitest-environment jsdom
/**
 * Smoke-render coverage for the group conversation detail page.
 *
 * Exercises the two focus-on-mount ref callbacks (S9379) introduced on this
 * page: the group-rename input in `DIDConversationView` and the member
 * search input in `AddMemberPicker`, both of which only mount once a viewer
 * with owner/admin role interacts with the header.
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

describe('group conversation header', () => {
  it('renders the rename input, focusing it on mount, without crashing', async () => {
    installFetch();

    render(<ConversationPage />);

    fireEvent.click(await screen.findByTitle('Click to rename'));

    const input = screen.getByPlaceholderText('Untitled Group');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });

  it('renders the add-member search input, focusing it on mount, without crashing', async () => {
    installFetch();

    render(<ConversationPage />);

    // The member-count control toggles the panel that holds "+ Add member";
    // it only offers that action once the owner/admin role loads.
    fireEvent.click(await screen.findByRole('button', { name: /member/i }));
    fireEvent.click(await screen.findByText('+ Add member'));

    const input = await screen.findByPlaceholderText('Search by name or handle…');
    expect(input).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
