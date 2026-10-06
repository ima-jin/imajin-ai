// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ETransferEmailCard from '../ETransferEmailCard';

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@imajin/ui', () => ({ useToast: () => ({ toast: toastMock }) }));

const DID = 'did:imajin:business';
const READ_URL = `/profile/api/profile/${encodeURIComponent(DID)}/etransfer-email`;
const WRITE_URL = `/profile/api/profile/${encodeURIComponent(DID)}`;

type Reply = { ok: boolean; body: unknown };

/** Routes the card's two endpoints; the PUT reply is configurable per test. */
function installFetch(options: { saved: string | null; put?: Reply; readThrows?: boolean }) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === READ_URL) {
      if (options.readThrows) throw new Error('offline');
      return { ok: true, json: async () => ({ etransferEmail: options.saved }) };
    }
    if (url === WRITE_URL && init?.method === 'PUT') {
      const reply = options.put ?? { ok: true, body: {} };
      return { ok: reply.ok, json: async () => reply.body };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const input = () => screen.getByLabelText('e-Transfer receiving email') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /Save|Saving/ }) as HTMLButtonElement;
const putBody = (spy: ReturnType<typeof installFetch>) =>
  JSON.parse((spy.mock.calls.find(([, init]) => init?.method === 'PUT')![1] as RequestInit).body as string);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ETransferEmailCard (#2665)', () => {
  it('loads the saved email from the owner-only endpoint into the field', async () => {
    const spy = installFetch({ saved: 'pay@biz.example' });
    render(<ETransferEmailCard profileDid={DID} />);

    await waitFor(() => expect(input().value).toBe('pay@biz.example'));
    expect(spy).toHaveBeenCalledWith(READ_URL, { credentials: 'include' });
    // Unchanged -> nothing to save.
    expect(saveButton().disabled).toBe(true);
  });

  it('starts empty when none is set, and explains that e-Transfer is only offered while it is set', async () => {
    installFetch({ saved: null });
    render(<ETransferEmailCard profileDid={DID} />);

    await waitFor(() => expect(input().value).toBe(''));
    expect(screen.getByText(/only while a receiving email is set/)).toBeDefined();
  });

  it('saves a normalised address with a PUT carrying only etransferEmail, and confirms', async () => {
    const spy = installFetch({ saved: null, put: { ok: true, body: { etransferEmail: 'pay@biz.example' } } });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(input()).toBeDefined());

    fireEvent.change(input(), { target: { value: '  Pay@Biz.Example ' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('e-Transfer email saved'));
    expect(putBody(spy)).toEqual({ etransferEmail: 'pay@biz.example' });
    expect(input().value).toBe('pay@biz.example');
  });

  it('clearing the field saves null and says e-Transfer is turned off', async () => {
    const spy = installFetch({ saved: 'pay@biz.example', put: { ok: true, body: { etransferEmail: null } } });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(input().value).toBe('pay@biz.example'));

    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('e-Transfer turned off'));
    expect(putBody(spy)).toEqual({ etransferEmail: null });
  });

  it('refuses an invalid address locally, with no request', async () => {
    const spy = installFetch({ saved: null });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(input()).toBeDefined());

    fireEvent.change(input(), { target: { value: 'not-an-email' } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(/exactly one @/)).toBeDefined();
    expect(spy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it("shows the server's rejection inline", async () => {
    installFetch({ saved: null, put: { ok: false, body: { error: 'etransferEmail can only be set on a business identity' } } });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(input()).toBeDefined());

    fireEvent.change(input(), { target: { value: 'pay@biz.example' } });
    fireEvent.click(saveButton());

    expect(await screen.findByText('etransferEmail can only be set on a business identity')).toBeDefined();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('shows a generic inline error when the save request throws or the error has no text', async () => {
    installFetch({ saved: null, put: { ok: false, body: {} } });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(input()).toBeDefined());
    fireEvent.change(input(), { target: { value: 'pay@biz.example' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Failed to save e-Transfer email')).toBeDefined();
  });

  it('toasts when the initial load fails', async () => {
    installFetch({ saved: null, readThrows: true });
    render(<ETransferEmailCard profileDid={DID} />);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Failed to load e-Transfer email'));
  });
});
