// @vitest-environment jsdom
/**
 * Smoke-render test for `JinPage` (default export). #2293 folded the
 * legacy inline GitHub proposal table into `OperatorApprovalsPanel`, so
 * this test only needs to confirm the page mounts its panel composition
 * (header + Vault/Access/OperatorApprovals/UsageFeed panels) without
 * throwing — per-panel behavior is covered by each panel's own test file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The nested UsageFeedPanel calls `useSearchParams`, which needs a Next
// router context that does not exist outside the app runtime.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const { default: JinPage } = await import('../page');

function installFetch() {
  const spy = vi.fn(async () => (
    { ok: true, status: 200, json: async () => ({ isOperator: false, approvals: [], entries: [] }) } as unknown as Response
  ));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JinPage', () => {
  it('renders the header and mounts without throwing', async () => {
    installFetch();

    render(<JinPage />);

    expect(await screen.findByText('/jin')).toBeDefined();
    expect(screen.getByText('Pending proposals — human approval surface')).toBeDefined();
  });
});
