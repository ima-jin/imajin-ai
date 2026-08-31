// @vitest-environment jsdom
/**
 * InvitationsTab — email delivery failure surfacing (#1860).
 *
 * `sendEmailInvite()` used to check only `res.ok` and always render "✓ Invite
 * sent successfully!", ignoring the `emailSent` field #1849 added to the
 * invite-create response. These tests pin that a real Postal failure now
 * renders a distinct state (with the shareable link as a fallback) instead
 * of a false success, while a true send still renders the original success
 * copy and other failure modes (HTTP error, network error) are unaffected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import InvitationsTab from '../invitations-tab';

const INVITES_URL = '/connections/api/invites';
const EMAIL = 'invitee@example.com';
const SUCCESS_MESSAGE = '✓ Invite sent successfully!';
// Matched as a substring (not exact) because the rendered text is prefixed
// with a ⚠️ emoji.
const FAILED_MESSAGE = /Invite created, but the email could not be delivered/;
const INVITE_URL = 'https://connections.example/invite/did:imajin:owner/abc123';

vi.mock('@imajin/ui', () => ({
  // The component renders outside a ToastProvider in this test; only the
  // link-generation path (not exercised here) calls toast.error.
  useToast: () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

function invitesListResponse() {
  return { invites: [], tier: 'established', limit: 20, pending: 0, remaining: 20 };
}

/** Fetch stub: GET calls (invited-by, invites list) succeed with empty data; POST is routed to `postImpl`. */
function installFetch(postImpl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      if (url === '/connections/api/invites/invited-by') {
        return { ok: true, json: async () => ({ invitedBy: null }) };
      }
      if (url === INVITES_URL) {
        return { ok: true, json: async () => invitesListResponse() };
      }
    }
    if (init?.method === 'POST' && url === INVITES_URL) {
      return postImpl();
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function openEmailPanelAndFillAddress() {
  await waitFor(() => expect(screen.getByText('Email Invite')).toBeDefined());
  fireEvent.click(screen.getByText('Email Invite'));
  fireEvent.change(screen.getByPlaceholderText('Email address'), { target: { value: EMAIL } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('successful email delivery', () => {
  it('renders the success state when emailSent is true', async () => {
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: true }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText(SUCCESS_MESSAGE)).toBeDefined());
    expect(screen.queryByText(FAILED_MESSAGE)).toBeNull();
  });
});

describe('email delivery failure (#1860)', () => {
  it('renders a distinct failed-delivery state instead of a false success when emailSent is false', async () => {
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: false }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText(FAILED_MESSAGE)).toBeDefined());
    expect(screen.queryByText(SUCCESS_MESSAGE)).toBeNull();
  });

  it('surfaces the invite link as a fallback and copies it on request', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: false }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    await waitFor(() => expect(screen.getByText(INVITE_URL)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INVITE_URL);
    await waitFor(() => expect(screen.getByRole('button', { name: '✓ Copied' })).toBeDefined());
  });

  it('returns to the send form via "Send another"', async () => {
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: false }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    await waitFor(() => expect(screen.getByText(FAILED_MESSAGE)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Send another' }));

    expect(screen.getByPlaceholderText('Email address')).toBeDefined();
  });
});

describe('email-failure banner still surfaces the fallback link (#1868 regression guard)', () => {
  it('renders the failure banner and the fallback invite link + working copy button together', async () => {
    // #1868: a prior report claimed the honest email-failed banner (#1867)
    // rendered with no way to retrieve the invite link at all. Assert both
    // pieces exist *in the same render* so a future change that keeps the
    // banner but drops the link (or vice versa) fails this test.
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: { code: 'abc123' }, url: INVITE_URL, emailSent: false }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText(FAILED_MESSAGE)).toBeDefined());
    // The invite link itself must be visible, not just referenced in copy.
    expect(screen.getByText(INVITE_URL)).toBeDefined();
    const copyButton = screen.getByRole('button', { name: 'Copy link' });
    expect(copyButton).toBeDefined();

    fireEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INVITE_URL);
  });

  it('surfaces the fallback link even when the invite code is missing', async () => {
    // Guards the `emailResult.code ?? emailResult.url` fallback key: if the
    // create response ever omits `invite.code`, the link must still render
    // and remain copyable using the url itself as the identity.
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    installFetch(async () => ({
      ok: true,
      json: async () => ({ invite: {}, url: INVITE_URL, emailSent: false }),
    }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText(INVITE_URL)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INVITE_URL);
  });
});

describe('email invite limit banner', () => {
  it('shows the limit-reached warning when quota is exhausted by a pending email invite', async () => {
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method && url === '/connections/api/invites/invited-by') {
        return { ok: true, json: async () => ({ invitedBy: null }) };
      }
      if (!init?.method && url === INVITES_URL) {
        return {
          ok: true,
          json: async () => ({
            invites: [{ id: 'inv_1', code: 'code1', toEmail: 'x@example.com', delivery: 'email', status: 'pending', createdAt: new Date().toISOString() }],
            tier: 'established',
            limit: 5,
            pending: 5,
            remaining: 0,
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', spy);

    render(<InvitationsTab />);
    await waitFor(() => expect(screen.getByText('Email Invite')).toBeDefined());
    fireEvent.click(screen.getByText('Email Invite'));

    expect(await screen.findByText(/Invite limit reached/)).toBeDefined();
  });
});

describe('other failure modes are unaffected', () => {
  it('shows the API error message on a non-ok response', async () => {
    installFetch(async () => ({ ok: false, json: async () => ({ error: 'Invite limit reached' }) }));

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText('Invite limit reached')).toBeDefined());
    expect(screen.queryByText(SUCCESS_MESSAGE)).toBeNull();
    expect(screen.queryByText(FAILED_MESSAGE)).toBeNull();
  });

  it('shows a generic error message when the request throws', async () => {
    installFetch(() => {
      throw new Error('network down');
    });

    render(<InvitationsTab />);
    await openEmailPanelAndFillAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => expect(screen.getByText('An error occurred')).toBeDefined());
  });
});
