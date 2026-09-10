// @vitest-environment jsdom
/**
 * Smoke-render test for `JinPage` (default export). Rendering a pending
 * proposal mounts its "Yes" button, which carries the focus-on-mount ref
 * callback (S9379) — the panel's other tests (usage-feed-*,
 * operator-approvals-panel) don't touch this file's own default export.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { installIntervalSpy } from './panel-test-support';

// The nested UsageFeedPanel calls `useSearchParams`, which needs a Next
// router context that does not exist outside the app runtime.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const { default: JinPage } = await import('../page');

function installFetch() {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/github/api/proposals')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          proposals: [{
            id: 'prop_1',
            ownerDid: 'did:imajin:owner',
            agentDid: null,
            scope: 'github:write',
            tool: 'github_update_issue',
            riskTier: 'mutate',
            target: 'org/repo#1',
            argsSummary: '{}',
            status: 'pending',
            approvedUntil: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
          }],
        }),
      } as unknown as Response;
    }
    // Operator-approvals / usage-feed panels also fetch on mount; a benign
    // empty response keeps them out of the way of this test's assertions.
    return { ok: true, status: 200, json: async () => ({ isOperator: false, approvals: [], entries: [] }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JinPage', () => {
  it('renders a pending proposal row and focuses its "Yes" button on mount', async () => {
    installIntervalSpy();
    installFetch();

    render(<JinPage />);

    const yesButton = await screen.findByRole('button', { name: 'Yes' });
    expect(document.activeElement).toBe(yesButton);
  });
});
