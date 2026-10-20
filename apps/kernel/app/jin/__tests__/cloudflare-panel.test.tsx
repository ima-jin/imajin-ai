// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudflarePanel } from '../cloudflare-panel';
import { APPROVALS_REFRESH_EVENT } from '../approval-anchor';
import { cloudflareUrl, validCloudflareZone } from '../cloudflare-client';

const zone = { zoneId: 'a'.repeat(32), domain: 'example.com' };
const record = { id: 'record-1', type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1, proxied: false, proxiable: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openZone(fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ records: [record] })))) {
  vi.stubGlobal('fetch', fetchMock);
  render(<CloudflarePanel />);
  fireEvent.change(screen.getByLabelText('Verified zone domain'), { target: { value: zone.domain } });
  fireEvent.change(screen.getByLabelText('Cloudflare zone ID'), { target: { value: zone.zoneId } });
  fireEvent.click(screen.getByRole('button', { name: 'Load zone' }));
  await screen.findByRole('button', { name: 'Edit www.example.com' });
  return fetchMock;
}
function body(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
}
async function idle() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Load zone' }) as HTMLButtonElement).disabled).toBe(false));
}

describe('Cloudflare operations', () => {
  it('uses exact canonical zone input and never asks for a credential', async () => {
    expect(validCloudflareZone(zone)).toBe(true);
    expect(validCloudflareZone({ ...zone, domain: 'EXAMPLE.com' })).toBe(false);
    expect(validCloudflareZone({ ...zone, zoneId: 'A'.repeat(32) })).toBe(false);
    const fetchMock = await openZone();
    expect(fetchMock.mock.calls[0][0]).toBe(cloudflareUrl(zone, 'dns'));
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
    expect(document.querySelector('input[type=password]')).toBeNull();
  });
  it('changes individual proxy state with an explicit checkbox', async () => {
    const fetchMock = await openZone();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Proxy www.example.com through Cloudflare' }));
    await idle();
    expect(fetchMock.mock.calls[1][0]).toContain('/dns/record-1?domain=example.com');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(body(fetchMock, 1)).toEqual({ proxied: true });
  });
  it('previews before requesting approval, preserves changes and refreshes the existing inbox', async () => {
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ before: false, after: true }))
      .mockResolvedValueOnce(Response.json({ approval: { proposalId: 'cf-proposal' } }, { status: 202 }));
    await openZone(fetchMock);
    expect(screen.queryByRole('button', { name: 'Request bulk approval' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select www.example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview bulk changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request bulk approval' }));
    const link = await screen.findByRole('link', { name: 'Review Cloudflare proposal' });
    expect(link.getAttribute('href')).toBe('#approval-cf-proposal');
    expect(body(fetchMock, 1)).toEqual({ domain: zone.domain, changes: [{ recordId: record.id, proxied: true }], dryRun: true });
    expect(body(fetchMock, 2)).toEqual({ ...body(fetchMock, 1), dryRun: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh);
  });
  it('invalidates a preview if selection or requested proxy state changes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ changes: [] }));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select www.example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview bulk changes' }));
    await screen.findByRole('button', { name: 'Request bulk approval' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable proxy for selected/ }));
    expect(screen.queryByRole('button', { name: 'Request bulk approval' })).toBeNull();
  });
  it('supports DNS create, edit and explicit delete confirmation', async () => {
    const fetchMock = await openZone();
    fireEvent.click(screen.getByRole('button', { name: 'Create DNS record' }));
    fireEvent.change(screen.getByLabelText('Record name'), { target: { value: 'new.example.com' } });
    fireEvent.change(screen.getByLabelText('Record content'), { target: { value: '192.0.2.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save DNS record' }));
    await idle();
    expect(body(fetchMock, 1)).toEqual({ type: 'A', name: 'new.example.com', content: '192.0.2.2', ttl: 1, proxied: false });
    fireEvent.click(screen.getByRole('button', { name: 'Edit www.example.com' }));
    fireEvent.change(screen.getByLabelText('Record content'), { target: { value: '192.0.2.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save DNS record' }));
    await idle();
    expect(fetchMock.mock.calls[3][1].method).toBe('PATCH');
    fireEvent.click(screen.getByRole('button', { name: 'Delete www.example.com' }));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm DNS deletion' }));
    await idle();
    expect(fetchMock.mock.calls[5][1].method).toBe('DELETE');
  });
  it.each([401, 403, 409, 502])('does not render provider failure details for HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ error: 'FAKE_SENSITIVE_PROVIDER_DETAIL' }, { status }));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Settings / SSL' }));
    await idle();
    expect(document.body.textContent).not.toContain('FAKE_SENSITIVE_PROVIDER_DETAIL');
    expect(screen.getByRole('status').textContent).toBeTruthy();
  });
  it('does not render network exceptions', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockRejectedValueOnce(new Error('FAKE_PRIVATE_NETWORK_ERROR'));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Settings / SSL' }));
    await idle();
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_NETWORK_ERROR');
  });
  it('shows signed actor, owner, zone, before, after and signature', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ history: [{
        id: 'audit-1', issuerDid: 'did:imajin:node', issuedAt: '2026-10-20T00:00:00Z',
        payload: { actorDid: 'did:imajin:actual-actor', onBehalfOf: 'did:imajin:group-owner', zoneId: zone.zoneId,
          operation: 'dns.update', phase: 'success', before: { proxied: false }, after: { proxied: true } }, signature: 'fake-node-signature',
      }] }));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Signed history' }));
    await screen.findByText('Actor: did:imajin:actual-actor');
    expect(screen.getByText('On behalf of: did:imajin:group-owner')).toBeDefined();
    expect(screen.getByText(`Zone: ${zone.zoneId}`)).toBeDefined();
    expect(screen.getByText(/fake-node-signature/)).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Before' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'After' })).toBeDefined();
  });
  it('authors cache rules using labelled fields and sends an ordered ruleset', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ rules: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ rules: [] }));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Cache rules' }));
    await screen.findByLabelText('Rule description');
    fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: 'Static assets' } });
    fireEvent.change(screen.getByLabelText('Match expression'), { target: { value: 'http.host eq "example.com"' } });
    fireEvent.change(screen.getByLabelText('Cache behavior'), { target: { value: 'ttl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview new cache rule' }));
    await idle();
    expect(body(fetchMock, 2)).toEqual({ domain: zone.domain, dryRun: true, rules: [{
      description: 'Static assets', expression: 'http.host eq "example.com"', action: 'set_cache_settings', enabled: true,
      action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 3600 } },
    }] });
  });
  it('creates a custom hostname without exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ records: [record] }))
      .mockResolvedValueOnce(Response.json({ hostnames: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ hostnames: [] }));
    await openZone(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Custom hostnames' }));
    await screen.findByLabelText('Custom hostname');
    fireEvent.change(screen.getByLabelText('Custom hostname'), { target: { value: 'customer.example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create custom hostname' }));
    await idle();
    expect(body(fetchMock, 2)).toEqual({ hostname: 'customer.example.net', ssl: { method: 'txt', type: 'dv' } });
  });
});
