// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudflareDelegations } from '../cloudflare-delegations';

const zone = { domain: 'example.com', zoneId: 'a'.repeat(32), granteeDid: 'did:imajin:A',
  capabilities: ['cloudflare:read' as const] };
const ownerDid = 'did:imajin:G';
const grant = { grantId: 'grant-test', agentDid: 'did:imajin:A', capabilities: ['cloudflare:dns'],
  expiry: '2026-10-21T00:00:00Z', revokedAt: null };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('credential-free Cloudflare zone grant controls', () => {
  it('lists, adds an arbitrary DID, renews and revokes with the existing grant lifecycle', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
      Response.json(init?.method ? { ok: true } : { grants: [grant, { ...grant, grantId: 'old', revokedAt: '2026-10-20' }] }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<CloudflareDelegations ownerDid={ownerDid} zone={zone} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage zone grants' }));
    await screen.findByLabelText('New zone grantee DID');
    expect(fetcher.mock.calls[0][0]).toContain('ownerDid=did%3Aimajin%3AG');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    fireEvent.change(screen.getByLabelText('New zone grantee DID'), { target: { value: 'did:web:member.example' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'cloudflare:dns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delegate zone operations' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      ownerDid, domain: zone.domain, zoneId: zone.zoneId, granteeDid: 'did:web:member.example',
      capabilities: ['cloudflare:read', 'cloudflare:dns'], ttlMs: 86400_000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Renew for 24 hours' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    expect(fetcher.mock.calls[3][0]).toBe('/auth/api/grants/grant-test/renew');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke zone grant' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(7));
    expect(fetcher.mock.calls[5]).toEqual(['/auth/api/grants/grant-test', expect.objectContaining({ method: 'DELETE' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Hide zone grants' }));
    await waitFor(() => expect(screen.queryByLabelText('New zone grantee DID')).toBeNull());
  });

  it.each(['metadata', 'shape', 'network', 'mutation'])('sanitizes %s failures', async failure => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ grants: [grant] }));
    if (failure === 'metadata') fetcher.mockResolvedValueOnce(Response.json({ error: 'FAKE_SECRET' }, { status: 403 }));
    if (failure === 'shape') fetcher.mockResolvedValueOnce(Response.json({ secret: 'FAKE_SECRET' }));
    if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('FAKE_SECRET'));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<CloudflareDelegations ownerDid={ownerDid} zone={zone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage zone grants' }));
    if (failure === 'mutation') {
      await screen.findByRole('button', { name: 'Revoke zone grant' });
      fetcher.mockResolvedValueOnce(Response.json({ error: 'FAKE_SECRET' }, { status: 503 }));
      fireEvent.click(screen.getByRole('button', { name: 'Revoke zone grant' }));
    }
    await screen.findByText('Zone grants unavailable. Check current owner authority and retry.');
    expect(container.innerHTML).not.toContain('FAKE_SECRET');
  });
});
