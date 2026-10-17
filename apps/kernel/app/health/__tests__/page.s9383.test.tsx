// @vitest-environment jsdom
/**
 * Health page — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `checkHealth()` without awaiting it; it now goes
 * through `fireAndForget`. (`checkHealth` handles its own failures, so there is
 * no rejection path to log.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

vi.mock('@imajin/ui', () => ({
  ImajinFooter: () => null,
}));

vi.mock('@imajin/config', () => ({
  APP_DISPLAY_NAME: 'Imajin',
}));

const { default: HealthPage } = await import('../page');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('health check on mount', () => {
  it('fetches the health status once on mount', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'operational',
        timestamp: '2024-01-01T00:00:00Z',
        services: [{ name: 'auth', kind: 'core', url: 'https://auth.example', status: 'up', responseTime: 12, statusCode: 200 }],
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<HealthPage />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    expect(await screen.findByText('12ms')).toBeDefined();
  });

  it('surfaces a failed check as an error instead of rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as unknown as Response));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<HealthPage />);

    expect(await screen.findByText(/Failed to fetch health status/)).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('groups third-party services using server kind and shows the registered external URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'degraded',
        services: [
          { name: 'auth', kind: 'core', url: 'https://node.example.test/auth', status: 'up', responseTime: 1 },
          { name: 'fixture-studio', label: 'Fixture Studio', kind: 'app', url: 'https://studio.example.test/', status: 'up', responseTime: 2 },
        ],
      }),
    }));
    render(<HealthPage />);
    const studio = await screen.findByRole('link', { name: 'Fixture Studio' });
    expect(studio.getAttribute('href')).toBe('https://studio.example.test/');
    expect(studio.closest('.space-y-3')?.textContent).toContain('Applications');
    expect(screen.getByText('https://studio.example.test/')).toBeDefined();
    expect(screen.queryByText('fixture-studio.imajin.ai')).toBeNull();
    expect(screen.getByText('Some Systems Degraded')).toBeDefined();
  });
});
