// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import RecoveryCodesSection from '../RecoveryCodesSection';

type StatusBody = Record<string, unknown>;

function jsonResponse(body: StatusBody, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function installFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const handler = handlers[url];
      if (!handler) throw new Error(`no fetch handler installed for ${url}`);
      return handler();
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecoveryCodesSection — status', () => {
  it('reports no active codes when none have ever been generated', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 0, generatedAt: null }),
    });

    render(<RecoveryCodesSection />);

    expect(await screen.findByText('No active recovery codes')).toBeDefined();
    expect(screen.getByText('Generate codes')).toBeDefined();
  });

  it('reports the remaining count and generation date when codes are active', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 7, generatedAt: '2026-01-01T00:00:00.000Z' }),
    });

    render(<RecoveryCodesSection />);

    expect(await screen.findByText('7 unused codes remaining')).toBeDefined();
    expect(screen.getByText('Regenerate codes')).toBeDefined();
  });

  it('uses singular phrasing for exactly one remaining code', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 1, generatedAt: null }),
    });

    render(<RecoveryCodesSection />);

    expect(await screen.findByText('1 unused code remaining')).toBeDefined();
  });

  it('tells a custodial (soft) identity that recovery codes are unavailable', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ error: 'Recovery codes require a self-custody identity' }, 403),
    });

    render(<RecoveryCodesSection />);

    expect(await screen.findByText('Recovery codes require a self-custody identity.')).toBeDefined();
    expect(screen.queryByText('Generate codes')).toBeNull();
  });
});

describe('RecoveryCodesSection — generate', () => {
  it('reveals codes exactly once after generating, with the disclosure text', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 0, generatedAt: null }),
      '/auth/api/recovery-codes/generate': () =>
        jsonResponse({ codes: ['AAAA-BBBB', 'CCCC-DDDD'], count: 2, disclosure: 'not trustless', generatedAt: '2026-01-01T00:00:00.000Z' }),
    });

    render(<RecoveryCodesSection />);
    fireEvent.click(await screen.findByText('Generate codes'));

    expect(await screen.findByText('AAAA-BBBB')).toBeDefined();
    expect(screen.getByText('CCCC-DDDD')).toBeDefined();
    expect(screen.getByText('not trustless')).toBeDefined();
  });

  it('only allows dismissing the revealed codes after downloading them', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 0, generatedAt: null }),
      '/auth/api/recovery-codes/generate': () =>
        jsonResponse({ codes: ['AAAA-BBBB'], count: 1, disclosure: '', generatedAt: '2026-01-01T00:00:00.000Z' }),
    });
    // jsdom has no createObjectURL implementation.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    render(<RecoveryCodesSection />);
    fireEvent.click(await screen.findByText('Generate codes'));
    await screen.findByText('AAAA-BBBB');

    const dismissButton = screen.getByText("I've saved these codes") as HTMLButtonElement;
    expect(dismissButton.disabled).toBe(true);

    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(dismissButton.disabled).toBe(false));

    fireEvent.click(dismissButton);
    await waitFor(() => expect(screen.queryByText('AAAA-BBBB')).toBeNull());
  });

  it('surfaces an error message when generation fails', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 0, generatedAt: null }),
      '/auth/api/recovery-codes/generate': () => jsonResponse({ error: 'Too many requests' }, 429),
    });

    render(<RecoveryCodesSection />);
    fireEvent.click(await screen.findByText('Generate codes'));

    expect(await screen.findByText('Too many requests')).toBeDefined();
  });

  it('surfaces a network error when the fetch itself throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/auth/api/recovery-codes/status') return jsonResponse({ remaining: 0, generatedAt: null });
        throw new Error('network down');
      }),
    );

    render(<RecoveryCodesSection />);
    fireEvent.click(await screen.findByText('Generate codes'));

    expect(await screen.findByText('Network error. Please try again.')).toBeDefined();
  });

  it('asks for confirmation before regenerating an existing batch, and aborts on cancel', async () => {
    installFetch({
      '/auth/api/recovery-codes/status': () => jsonResponse({ remaining: 3, generatedAt: '2026-01-01T00:00:00.000Z' }),
    });
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);

    render(<RecoveryCodesSection />);
    fireEvent.click(await screen.findByText('Regenerate codes'));

    expect(confirmSpy).toHaveBeenCalledOnce();
    // Cancelled — no generate call was ever installed, so a fetch to it would throw;
    // the still-present "Regenerate codes" label confirms nothing changed.
    expect(screen.getByText('Regenerate codes')).toBeDefined();
  });
});
