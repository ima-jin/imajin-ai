// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const getEffectiveDidMock = vi.fn();
const selectResults: unknown[][] = [];

vi.mock('../../lib/get-effective-did', () => ({
  getEffectiveDid: getEffectiveDidMock,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

async function nextSelectResult() {
  return selectResults.shift() ?? [];
}

function limitStep() {
  return { limit: nextSelectResult };
}

function whereStep() {
  return { where: limitStep };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: whereStep }),
  },
  identities: {},
}));

vi.mock('../components/MoneyTab', () => ({
  default: ({ issuerDid }: { issuerDid: string }) => <div>Money tab for {issuerDid}</div>,
}));

const { default: MoneyPage } = await import('../page');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectResults.length = 0;
});

describe('MoneyPage — gating', () => {
  it('redirects unauthenticated visitors to /auth', async () => {
    getEffectiveDidMock.mockResolvedValue({ sessionDid: null, effectiveDid: null });

    await expect(MoneyPage()).rejects.toThrow('REDIRECT:/auth');
  });

  it('renders the Money tab for a business identity', async () => {
    getEffectiveDidMock.mockResolvedValue({ sessionDid: 'did:imajin:owner', effectiveDid: 'did:imajin:business' });
    selectResults.push([{ scope: 'business' }]);

    const jsx = await MoneyPage();
    render(jsx);

    expect(screen.getByText('Money tab for did:imajin:business')).toBeDefined();
  });

  it('shows an explanatory message instead of the tab for a non-business identity', async () => {
    getEffectiveDidMock.mockResolvedValue({ sessionDid: 'did:imajin:owner', effectiveDid: 'did:imajin:owner' });
    selectResults.push([{ scope: 'actor' }]);

    const jsx = await MoneyPage();
    render(jsx);

    expect(screen.getByText(/only available for business identities/)).toBeDefined();
  });
});
