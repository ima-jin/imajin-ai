// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GrantsPanel } from '../grants-panel';
import type { GrantCard, GrantSourceKind } from '@/src/lib/jin/grants-lane';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function showCard(overrides: Partial<GrantCard> = {}) {
  const card: GrantCard = {
    id: 'app-authorization:grant', source: 'app-authorization', grantee: 'Test app',
    capabilities: [], issuedAt: '2026-09-01T00:00:00Z', lastUsedAt: null,
    ackState: null, ackEvidence: null, status: 'active', revocable: true,
    revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: 'grant' } }, ...overrides,
  };
  const transport = vi.fn(async () => ({
    ok: true, json: async () => ({ isOperator: true, grants: [card] }),
  } as Response));
  render(<GrantsPanel transport={transport} />);
  return transport;
}

describe('grant usage labels (#3009)', () => {
  it('labels pre-recording history honestly and leaves revoke available without auto-revoking', async () => {
    const transport = showCard({ lastUsedNotRecordedBefore: '2026-10-22' });
    expect(await screen.findByText('last used: not recorded before 2026-10-22')).toBeDefined();
    expect(screen.queryByText('last used never')).toBeNull();
    expect(screen.getByText('unused 30d+')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined();
    expect(transport.mock.calls).toHaveLength(1);
  });

  it.each(['auth-grant', 'vault-delegation', 'access-bearer', 'app-authorization'] as GrantSourceKind[])('shows real last-used for %s, and recent use is not idle', async source => {
    const lastUsedAt = new Date().toISOString();
    showCard({ source, lastUsedAt });
    expect(await screen.findByText(`last used ${new Date(lastUsedAt).toLocaleString()}`)).toBeDefined();
    expect(screen.queryByText('unused 30d+')).toBeNull();
  });

  it('keeps never for a newly issued app grant with no recorded use', async () => {
    showCard({ issuedAt: new Date().toISOString() });
    expect(await screen.findByText('last used never')).toBeDefined();
    expect(screen.queryByText('unused 30d+')).toBeNull();
  });

  it('does not label an expired app grant idle', async () => {
    showCard({ status: 'expired', revocable: false, revoke: null });
    await screen.findByTestId('grant-card');
    expect(screen.queryByText('unused 30d+')).toBeNull();
  });
});
