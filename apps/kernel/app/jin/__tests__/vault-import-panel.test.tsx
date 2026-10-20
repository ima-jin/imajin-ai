// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VaultImportPanel } from '../vault-import-panel';
import { APPROVALS_REFRESH_EVENT } from '../approval-anchor';

const person = 'did:imajin:test-admin';
const org = 'did:imajin:test-org';
const consumer = 'did:imajin:test-agent';
const metadata = {
  ownerDid: org,
  owners: [{ did: person, name: 'Admin' }, { did: org, name: 'Test organization' }],
  cards: [{
    field: 'vault-import:test', ownerDid: org, consumerDid: consumer, purpose: 'analysis',
    label: 'SonarCloud', fingerprint: 'test-fingerprint', grantId: 'vdg-test',
    provenance: 'imported', status: 'active', timeline: [
      { type: 'imported', at: '2026-10-17T00:00:00Z' },
      { type: 'granted', at: '2026-10-17T00:00:01Z' },
      { type: 'fetched', at: '2026-10-17T00:00:02Z', alert: true },
      { type: 'acked', at: '2026-10-17T00:00:03Z' },
    ],
  }],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fillImport() {
  const credential = await screen.findByLabelText('Credential') as HTMLInputElement;
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'analysis' } });
  fireEvent.change(screen.getByLabelText('Consumer agent or service DID'), { target: { value: consumer } });
  fireEvent.change(credential, { target: { value: 'OBVIOUSLY_FAKE_INPUT_ONLY' } });
  return credential;
}

describe('VaultImportPanel', () => {
  it('rotates an existing Cloudflare import through the same zone-bound masked form', async () => {
    const cloudflare = { domain: 'example.com', zoneId: 'a'.repeat(32), granteeDid: consumer, capabilities: ['cloudflare:read', 'cloudflare:dns'] };
    const cloudflareMetadata = {
      ...metadata, nodeDid: 'did:imajin:node', domains: [{ domain: cloudflare.domain, ownerDid: org }],
      cards: [{ ...metadata.cards[0], consumerDid: 'did:imajin:node', purpose: `dns.cloudflare:${cloudflare.zoneId}`, cloudflare }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(cloudflareMetadata))
      .mockResolvedValueOnce(Response.json({ proposalId: 'cloudflare-rotation' }))
      .mockResolvedValue(Response.json(cloudflareMetadata));
    vi.stubGlobal('fetch', fetchMock);
    render(<VaultImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-import to rotate' }));
    expect((screen.getByLabelText('Import mode') as HTMLSelectElement).value).toBe('cloudflare');
    expect((screen.getByLabelText('Verified zone domain') as HTMLSelectElement).value).toBe('example.com');
    expect((screen.getByLabelText('Cloudflare zone ID') as HTMLInputElement).value).toBe(cloudflare.zoneId);
    expect((screen.getByLabelText('Capability grantee DID') as HTMLInputElement).value).toBe(consumer);
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'FAKE_ROTATION_INPUT_ONLY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal replacement and propose rotation' }));
    await screen.findByRole('link', { name: 'Review import proposal' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ cloudflare, replacesField: metadata.cards[0].field });
  });
  it('uses one masked import form for a verified group Cloudflare zone and arbitrary DID grantee', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      ...metadata, nodeDid: 'did:imajin:node', domains: [
        { domain: 'example.com', ownerDid: org }, { domain: 'personal.example', ownerDid: person },
      ],
    })).mockResolvedValueOnce(Response.json({ proposalId: 'cloudflare-proposal' }))
      .mockResolvedValue(Response.json(metadata));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VaultImportPanel />);
    const secret = await fillImport();
    fireEvent.change(screen.getByLabelText('Import mode'), { target: { value: 'cloudflare' } });
    expect(secret.value).toBe('');
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    const domain = screen.getByLabelText('Verified zone domain') as HTMLSelectElement;
    expect([...domain.options].map(option => option.value)).toEqual(['', 'example.com']);
    fireEvent.change(domain, { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText('Cloudflare zone ID'), { target: { value: 'a'.repeat(32) } });
    fireEvent.change(screen.getByLabelText('Capability grantee DID'), { target: { value: 'did:web:external.example' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'cloudflare:dns' }));
    fireEvent.change(secret, { target: { value: 'FAKE_CLOUDFLARE_INPUT_ONLY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal and propose import' }));
    expect(secret.value).toBe('');
    await screen.findByRole('link', { name: 'Review import proposal' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      ownerDid: org, consumerDid: 'did:imajin:node', purpose: `dns.cloudflare:${'a'.repeat(32)}`,
      secret: 'FAKE_CLOUDFLARE_INPUT_ONLY',
      cloudflare: { domain: 'example.com', zoneId: 'a'.repeat(32), granteeDid: 'did:web:external.example', capabilities: ['cloudflare:read', 'cloudflare:dns'] },
    });
    expect(container.innerHTML).not.toContain('FAKE_CLOUDFLARE_INPUT_ONLY');
  });
  it('shows the group owner before sealing and clears the masked field synchronously', async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockResolvedValue(Response.json(metadata));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    const { container } = render(<VaultImportPanel />);
    const input = await fillImport();
    expect(screen.getByTestId('import-owner').textContent).toContain(org);
    expect(screen.getByTestId('import-owner').textContent).toContain('Test organization');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'SonarCloud' } });
    fireEvent.change(screen.getByLabelText('Grant expiry (optional)'), { target: { value: '2027-01-01T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal and propose import' }));
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(container.innerHTML).not.toContain('OBVIOUSLY_FAKE_INPUT_ONLY');
    expect(screen.getByRole('button', { name: 'Sealing…' })).toBeDefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      ownerDid: org, purpose: 'analysis', consumerDid: consumer, secret: 'OBVIOUSLY_FAKE_INPUT_ONLY',
      label: 'SonarCloud', expiresAt: new Date('2027-01-01T12:00').toISOString(),
    });
    complete(Response.json({ proposalId: 'test-proposal', status: 'pending' }));
    const link = await screen.findByRole('link', { name: 'Review import proposal' });
    expect(link.getAttribute('href')).toBe('#approval-test-proposal');
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /reveal|copy/i })).toBeNull();
    globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh);
  });

  it('changes the explicit owner and clears a paste before any identity change', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(Response.json({ proposalId: 'test-person' }))
      .mockResolvedValue(Response.json(metadata));
    vi.stubGlobal('fetch', fetchMock);
    render(<VaultImportPanel />);
    const input = await fillImport();
    fireEvent.change(screen.getByLabelText('Owning identity'), { target: { value: person } });
    expect(input.value).toBe('');
    expect(screen.getByTestId('import-owner').textContent).toContain(person);
    expect(screen.queryByTestId('imported-credential-card')).toBeNull();
    fireEvent.change(input, { target: { value: 'OBVIOUSLY_FAKE_SECOND_PASTE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal and propose import' }));
    await screen.findByRole('link', { name: 'Review import proposal' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).ownerDid).toBe(person);
  });

  it.each(['response', 'network', 'json', 'shape'])('never echoes input or underlying %s errors', async (failure) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata));
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_INPUT_ONLY'));
    else if (failure === 'json') fetchMock.mockResolvedValueOnce({ ok: true, json: () => { throw new Error('OBVIOUSLY_FAKE_INPUT_ONLY'); } });
    else if (failure === 'shape') fetchMock.mockResolvedValueOnce(Response.json({ secret: 'OBVIOUSLY_FAKE_INPUT_ONLY' }));
    else fetchMock.mockResolvedValueOnce(Response.json({ error: 'OBVIOUSLY_FAKE_INPUT_ONLY' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VaultImportPanel />);
    const input = await fillImport();
    fireEvent.click(screen.getByRole('button', { name: 'Seal and propose import' }));
    await screen.findByText('Import proposal failed. The value was cleared; paste again to retry.');
    expect(container.innerHTML).not.toContain('OBVIOUSLY_FAKE_INPUT_ONLY');
    expect(input.value).toBe('');
    expect(input.disabled).toBe(false);
    expect(screen.queryByRole('link', { name: 'Review import proposal' })).toBeNull();
  });

  it('renders imported → granted → fetched → acked metadata with the unacked warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(metadata)));
    render(<VaultImportPanel />);
    const card = await screen.findByTestId('imported-credential-card');
    expect(within(card).getByText(/Owner:/).textContent).toContain(org);
    expect(within(card).getByText(/Consumer:/).textContent).toContain(consumer);
    expect([...card.querySelectorAll('[data-timeline-type]')].map((row) => row.getAttribute('data-timeline-type')))
      .toEqual(['imported', 'granted', 'fetched', 'acked']);
    expect(within(card).getByText(/no ack yet/).className).toContain('text-red-300');
    expect(screen.getByText(/hand-provisioned/)).toBeDefined();
    expect(screen.getByText(/Remove the old .env.local/)).toBeDefined();
  });

  it('rotates through a new paste with the original field and owner bound to the proposal', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(Response.json({ proposalId: 'test-rotate' }))
      .mockResolvedValue(Response.json(metadata));
    vi.stubGlobal('fetch', fetchMock);
    render(<VaultImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-import to rotate' }));
    expect((screen.getByLabelText('Owning identity') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Purpose') as HTMLInputElement).value).toBe('analysis');
    expect((screen.getByLabelText('Consumer agent or service DID') as HTMLInputElement).value).toBe(consumer);
    expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('SonarCloud');
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'OBVIOUSLY_FAKE_REPLACEMENT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal replacement and propose rotation' }));
    await screen.findByRole('link', { name: 'Review import proposal' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      ownerDid: org, replacesField: 'vault-import:test', secret: 'OBVIOUSLY_FAKE_REPLACEMENT',
    });
  });

  it('can cancel rotation without submitting and supports unnamed/revoked cards', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...metadata, cards: [
      { ...metadata.cards[0], label: null },
      { ...metadata.cards[0], field: 'revoked', label: undefined, status: 'revoked', grantId: null },
    ] })));
    render(<VaultImportPanel />);
    const rotate = await screen.findByRole('button', { name: 'Re-import to rotate' });
    fireEvent.click(rotate);
    expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'OBVIOUSLY_FAKE_CANCELED_PASTE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rotation' }));
    expect((screen.getByLabelText('Owning identity') as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByLabelText('Credential') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Seal and propose import' })).toBeDefined();
  });

  it.each([null, {}, { ...metadata, owners: [] }, { ...metadata, ownerDid: 'unknown' },
    { ...metadata, cards: [null] }, { ...metadata, cards: [{ ...metadata.cards[0], timeline: [null] }] },
    { ...metadata, owners: [null] }, { ...metadata, cards: [{ ...metadata.cards[0], grantId: {} }] },
  ])('fails closed on malformed metadata', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VaultImportPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it.each([401, 403, 503])('hides unavailable metadata (%s)', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VaultImportPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('hides on metadata network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VaultImportPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
