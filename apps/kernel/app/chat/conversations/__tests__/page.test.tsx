// @vitest-environment jsdom
/**
 * Conversations list — delete control visibility (#1651).
 *
 * `DELETE /chat/api/conversations/:id` is creator-only, so the row control has
 * to be too. These tests render the real page against a stubbed
 * `GET /chat/api/conversations` payload and assert on the rendered controls,
 * which is the only place the creator/non-creator distinction becomes visible
 * to a user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ME = 'did:imajin:alice';
const THEM = 'did:imajin:bob';

// The page reads the session through the identity context and opens a
// WebSocket on mount; neither has a backend in a unit test.
const identityState: { identity: { did: string } | null; loading: boolean } = {
  identity: { did: ME },
  loading: false,
};

vi.mock('@/src/contexts/IdentityContext', () => ({
  useIdentity: () => identityState,
  LoginPrompt: () => <div>Sign In</div>,
}));

vi.mock('@/src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    lastMessage: null,
    isConnected: false,
    subscribe: vi.fn(),
    sendTyping: vi.fn(),
    sendStopTyping: vi.fn(),
  }),
}));

// next/link needs an app-router context that does not exist outside the Next
// runtime; the row only uses it to navigate to the conversation.
vi.mock('next/link', () => ({
  default: ({ href, children, className }: Readonly<{ href: string; children: React.ReactNode; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// The modal pulls in SWR and the connections service; nothing here opens it.
vi.mock('@/app/chat/components/NewChatModal', () => ({
  NewChatModal: () => null,
}));

const { default: ConversationsPage } = await import('../page');

interface ConversationSeed {
  did: string;
  name: string;
  createdBy: string;
}

function conversation({ did, name, createdBy }: ConversationSeed) {
  return {
    did,
    name,
    type: 'group',
    createdBy,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: '2026-01-02T00:00:00.000Z',
    lastMessagePreview: 'hello',
    unread: 0,
    otherParticipant: null,
  };
}

/**
 * Stub the list endpoint. Presence lookups and the DELETE both fall through to
 * a bare 200, and `deleteStatus` overrides the DELETE when a test needs a
 * refusal.
 */
function installFetch(seeds: ConversationSeed[], deleteStatus = 200) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/chat/api/conversations') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ conversations: seeds.map(conversation) }),
      } as unknown as Response;
    }
    if (init?.method === 'DELETE') {
      return { ok: deleteStatus < 400, status: deleteStatus, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ online: false }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const MINE_NAME = 'My Group';
const THEIRS_NAME = 'Their Group';
const MINE: ConversationSeed = { did: 'did:imajin:group:mine', name: MINE_NAME, createdBy: ME };
const THEIRS: ConversationSeed = { did: 'did:imajin:group:theirs', name: THEIRS_NAME, createdBy: THEM };

function deleteTrigger(name: string) {
  return screen.queryByRole('button', { name: `Delete conversation ${name}` });
}

beforeEach(() => {
  identityState.identity = { did: ME };
  identityState.loading = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delete control visibility', () => {
  it('shows the delete control on a conversation the viewer created', async () => {
    installFetch([MINE]);

    render(<ConversationsPage />);

    expect(await screen.findByText(MINE_NAME)).toBeDefined();
    expect(deleteTrigger(MINE_NAME)).not.toBeNull();
  });

  it('hides the delete control on a conversation someone else created', async () => {
    installFetch([THEIRS]);

    render(<ConversationsPage />);

    expect(await screen.findByText(THEIRS_NAME)).toBeDefined();
    expect(deleteTrigger(THEIRS_NAME)).toBeNull();
  });

  it('decides per row when the list mixes both', async () => {
    installFetch([MINE, THEIRS]);

    render(<ConversationsPage />);

    expect(await screen.findByText(MINE_NAME)).toBeDefined();
    expect(deleteTrigger(MINE_NAME)).not.toBeNull();
    expect(deleteTrigger(THEIRS_NAME)).toBeNull();
  });
});

describe('deleting from the list', () => {
  async function confirmDelete() {
    fireEvent.click(deleteTrigger(MINE_NAME) as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
    fireEvent.click(confirm as HTMLElement);
  }

  it('removes the row from local state once the API confirms', async () => {
    const spy = installFetch([MINE, THEIRS]);

    render(<ConversationsPage />);
    expect(await screen.findByText(MINE_NAME)).toBeDefined();

    await confirmDelete();

    await waitFor(() => expect(screen.queryByText(MINE_NAME)).toBeNull());
    // The sibling row survives — the delete is scoped to one conversation, and
    // the list is not refetched.
    expect(screen.getByText(THEIRS_NAME)).toBeDefined();
    expect(spy).toHaveBeenCalledWith(
      `/chat/api/conversations/${encodeURIComponent(MINE.did)}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps the row and surfaces the error when the API refuses', async () => {
    installFetch([MINE], 403);

    render(<ConversationsPage />);
    expect(await screen.findByText(MINE_NAME)).toBeDefined();

    await confirmDelete();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(MINE_NAME)).toBeDefined();
  });
});
