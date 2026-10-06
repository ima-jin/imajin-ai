// @vitest-environment jsdom
/**
 * InvitationsTab — floating promises (typescript:S9383) are now wrapped in
 * fireAndForget: the mount fetch, the post-create / post-delete refreshes of
 * the sent-invites list and the clipboard copy. Behaviour must be unchanged;
 * a rejected clipboard write must be logged via console.error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import InvitationsTab from '../invitations-tab';

const INVITES_URL = '/connections/api/invites';
const INVITE_URL = 'https://connections.example/invite/did:imajin:owner/abc123';

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => null,
}));

type Row = {
  id: string; code: string; toEmail: string | null; toDid: string | null; note: string | null;
  delivery: 'link' | 'email'; status: string; usedCount: number; maxUses: number;
  createdAt: string | null; acceptedAt: string | null; url?: string;
};

const sentRow: Row = {
  id: 'i1', code: 'abc123', toEmail: 'pal@example.com', toDid: null, note: null,
  delivery: 'link', status: 'pending', usedCount: 0, maxUses: 1,
  createdAt: '2026-01-01T00:00:00Z', acceptedAt: null, url: INVITE_URL,
};

interface FetchOpts {
  invites?: Row[];
  postImpl?: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

function installFetch(opts: FetchOpts = {}) {
  const invites = opts.invites ?? [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/connections/api/invites/invited-by') {
      return { ok: true, json: async () => ({ invitedBy: null }) };
    }
    if (method === 'GET' && url === INVITES_URL) {
      return {
        ok: true,
        json: async () => ({ invites, tier: 'established', limit: 20, pending: invites.length, remaining: 20 }),
      };
    }
    if (method === 'POST' && url === INVITES_URL) {
      if (opts.postImpl) return opts.postImpl();
      return { ok: true, json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: true }) };
    }
    if (method === 'DELETE' && url.startsWith(`${INVITES_URL}/`)) {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url} ${method}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function listFetchCount(spy: ReturnType<typeof installFetch>) {
  return spy.mock.calls.filter(([url, init]) => url === INVITES_URL && !(init as RequestInit | undefined)?.method).length;
}

function stubClipboard(writeText: (t: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mount effect', () => {
  it('fetches invited-by and the sent invites once on mount and fires onCountUpdate', async () => {
    const onCountUpdate = vi.fn();
    const spy = installFetch({ invites: [sentRow] });
    render(<InvitationsTab onCountUpdate={onCountUpdate} />);

    await waitFor(() => expect(onCountUpdate).toHaveBeenCalledWith(1, 20));
    expect(listFetchCount(spy)).toBe(1);
    expect(spy).toHaveBeenCalledWith('/connections/api/invites/invited-by');
    await waitFor(() => expect(screen.getByText('Founding member')).toBeDefined());
  });
});

describe('refreshes after mutations', () => {
  it('refreshes the sent invites after generating a link', async () => {
    const spy = installFetch();
    render(<InvitationsTab />);
    await waitFor(() => expect(listFetchCount(spy)).toBe(1));

    fireEvent.click(screen.getByText('Generate Link'));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate Link' }));

    await waitFor(() => expect(listFetchCount(spy)).toBe(2));
  });

  it('refreshes the sent invites after a successful email invite', async () => {
    const spy = installFetch();
    render(<InvitationsTab />);
    await waitFor(() => expect(listFetchCount(spy)).toBe(1));

    fireEvent.click(screen.getByText('Email Invite'));
    fireEvent.change(screen.getByPlaceholderText('Email address'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(listFetchCount(spy)).toBe(2));
    await waitFor(() => expect(screen.getByText('✓ Invite sent successfully!')).toBeDefined());
  });

  it('refreshes the sent invites when the email error reports a pending invite', async () => {
    const spy = installFetch({
      postImpl: async () => ({ ok: false, json: async () => ({ error: 'You already have a pending invite', pendingInvite: true }) }),
    });
    render(<InvitationsTab />);
    await waitFor(() => expect(listFetchCount(spy)).toBe(1));

    fireEvent.click(screen.getByText('Email Invite'));
    fireEvent.change(screen.getByPlaceholderText('Email address'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(listFetchCount(spy)).toBe(2));
    await waitFor(() => expect(screen.getByText(/already have a pending invite/)).toBeDefined());
  });

  it('does not refresh on an email error without pendingInvite', async () => {
    const spy = installFetch({
      postImpl: async () => ({ ok: false, json: async () => ({ error: 'nope' }) }),
    });
    render(<InvitationsTab />);
    await waitFor(() => expect(listFetchCount(spy)).toBe(1));

    fireEvent.click(screen.getByText('Email Invite'));
    fireEvent.change(screen.getByPlaceholderText('Email address'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText(/nope/)).toBeDefined());
    expect(listFetchCount(spy)).toBe(1);
  });
});

describe('sent invites table actions', () => {
  it('copies the invite link to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    installFetch({ invites: [sentRow] });
    render(<InvitationsTab />);

    const copyButton = await screen.findByRole('button', { name: 'Copy' });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(INVITE_URL);
  });

  it('logs a clipboard rejection through console.error without an unhandled rejection', async () => {
    const err = new Error('denied');
    stubClipboard(async () => { throw err; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    installFetch({ invites: [sentRow] });
    render(<InvitationsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[invitations:clipboard] unhandled async error', err),
    );
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('refreshes the sent invites after deleting an invite', async () => {
    const spy = installFetch({ invites: [sentRow] });
    render(<InvitationsTab />);
    await waitFor(() => expect(listFetchCount(spy)).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(listFetchCount(spy)).toBe(2));
    expect(spy.mock.calls.some(([url, init]) => url === `${INVITES_URL}/abc123` && (init as RequestInit)?.method === 'DELETE')).toBe(true);
  });
});
