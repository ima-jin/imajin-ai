// @vitest-environment jsdom
/**
 * Pay top-up page — S9383 floating-promise fixes (#2568).
 *
 * Both e-Transfer "Copy" buttons call `navigator.clipboard.writeText()` without
 * awaiting it; they now go through `fireAndForget`. The UI feedback ("Copied!")
 * is unchanged and a failed write is logged instead of rejecting.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const { default: TopupPage } = await import('../page');

const EMT = { email: 'pay@imajin.example', amount: 50, memo: 'MEMO-12345' };

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/session') return { ok: true, json: async () => ({}) } as unknown as Response;
    if (url === '/pay/api/topup/emt') {
      return { ok: true, json: async () => ({ instructions: EMT }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

/** Walks the wizard to the e-Transfer instructions (step 3). */
async function openEmtInstructions() {
  installFetch();
  render(<TopupPage />);
  fireEvent.click(await screen.findByText('Continue'));
  fireEvent.click(screen.getByText('Interac e-Transfer'));
  fireEvent.click(screen.getByText('Confirm e-Transfer →'));
  await screen.findByText('Send your e-Transfer');
  return screen.getAllByText('Copy');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('memo copy', () => {
  it('copies the memo and shows the copied state', async () => {
    const writeText = vi.fn(async () => {});
    installClipboard(writeText);
    const [, memoCopy] = await openEmtInstructions();

    fireEvent.click(memoCopy);

    expect(writeText).toHaveBeenCalledWith(EMT.memo);
    expect(screen.getAllByText('Copied!').length).toBeGreaterThan(0);
  });

  it('logs instead of rejecting when the memo copy fails', async () => {
    const boom = new Error('clipboard denied');
    installClipboard(async () => { throw boom; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [, memoCopy] = await openEmtInstructions();

    fireEvent.click(memoCopy);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[pay:topup:copyMemo] unhandled async error', boom),
    );
  });
});

describe('email copy', () => {
  it('copies the e-Transfer email and shows the copied state', async () => {
    const writeText = vi.fn(async () => {});
    installClipboard(writeText);
    const [emailCopy] = await openEmtInstructions();

    fireEvent.click(emailCopy);

    expect(writeText).toHaveBeenCalledWith(EMT.email);
    expect(screen.getAllByText('Copied!').length).toBeGreaterThan(0);
  });

  it('logs instead of rejecting when the email copy fails', async () => {
    const boom = new Error('clipboard denied');
    installClipboard(async () => { throw boom; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [emailCopy] = await openEmtInstructions();

    fireEvent.click(emailCopy);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[pay:topup:copyEmail] unhandled async error', boom),
    );
  });
});
