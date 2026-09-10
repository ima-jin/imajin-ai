// @vitest-environment jsdom
/**
 * Smoke-render test for the kernel onboard page. Choosing "Continue with
 * email" mounts the email input that carries the focus-on-mount ref
 * callback (S9379).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const { default: OnboardPage } = await import('../page');

function installFetch() {
  const spy = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as unknown as Response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OnboardPage', () => {
  it('reveals the email input and focuses it on mount, without crashing', async () => {
    installFetch();

    render(<OnboardPage />);

    fireEvent.click(await screen.findByText('Continue with email'));

    const input = screen.getByPlaceholderText('Email address');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });
});
