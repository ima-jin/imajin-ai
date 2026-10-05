// @vitest-environment jsdom
/**
 * App error boundary — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `reportError()` without awaiting it; it now goes
 * through `fireAndForget`. The client-error POST is unchanged.
 * (`reportError` swallows its own failures, so there is no rejection path.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

const { default: ErrorBoundary } = await import('../error');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('error reporting on mount', () => {
  it('posts the error to the client-errors endpoint', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const error = Object.assign(new Error('render exploded'), { digest: 'abc' });

    render(<ErrorBoundary error={error} reset={() => {}} />);

    expect(screen.getByText('Something went wrong')).toBeDefined();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/client-errors');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)[0].message).toBe('render exploded');
  });

  it('does not reject or log when the report request fails', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchSpy);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ErrorBoundary error={new Error('render exploded')} reset={() => {}} />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
