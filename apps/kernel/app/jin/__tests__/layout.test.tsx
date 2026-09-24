// @vitest-environment jsdom
/**
 * #2359: the act-as banner is mounted by the /jin LAYOUT, not by any one
 * lane, so no lane can be reached without it. These tests drive the async
 * server component directly (`const jsx = await JinLayout(...)`), the same
 * convention `app/auth/money/__tests__/page.test.tsx` established.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const getEffectiveDidMock = vi.fn();

vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: getEffectiveDidMock,
}));

const { default: JinLayout } = await import('../layout');

const SESSION_DID = 'did:imajin:ryan-operator';
const GROUP_DID = 'did:imajin:some-group';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('JinLayout act-as banner (#2359)', () => {
  it('renders the banner above the lane whenever the acting DID differs from the session DID', async () => {
    getEffectiveDidMock.mockResolvedValue({ sessionDid: SESSION_DID, effectiveDid: GROUP_DID });

    render(await JinLayout({ children: <p>lane</p> }));

    expect(screen.getByTestId('act-as-banner')).toBeDefined();
    expect(screen.getByText('lane')).toBeDefined();
  });

  it('renders the lane with no banner when the operator is plainly themselves', async () => {
    getEffectiveDidMock.mockResolvedValue({ sessionDid: SESSION_DID, effectiveDid: SESSION_DID });

    render(await JinLayout({ children: <p>lane</p> }));

    expect(screen.queryByTestId('act-as-banner')).toBeNull();
    expect(screen.getByText('lane')).toBeDefined();
  });
});
