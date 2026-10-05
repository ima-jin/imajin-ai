// @vitest-environment jsdom
/**
 * PayoutSetupBanner — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `checkConnectStatus()` without awaiting it; it now
 * goes through `fireAndForget`. Banner behaviour is unchanged and a rejection
 * is logged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

const { PayoutSetupBanner } = await import('../PayoutSetupBanner');

const DID = 'did:imajin:alice';
const MESSAGE = 'Set up payouts to receive funds';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connect status check on mount', () => {
  it('shows the banner when the account is not connected (404)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<PayoutSetupBanner did={DID} />);

    expect(await screen.findByText(MESSAGE)).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith(`/pay/api/connect/status?did=${DID}`, expect.anything());
  });

  it('hides the banner once onboarding is complete', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ onboardingComplete: true }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<PayoutSetupBanner did={DID} />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
  });

  it('does not check the status when no did is given', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<PayoutSetupBanner did="" />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('logs through fireAndForget instead of rejecting when the check itself throws', async () => {
    const boom = new Error('console broke');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      // The component's own catch-block log: make it throw so the promise rejects.
      if (args[0] === 'Error checking connect status for banner:') throw boom;
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    render(<PayoutSetupBanner did={DID} />);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[pay:PayoutSetupBanner:checkConnectStatus] unhandled async error', boom),
    );
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });
});
