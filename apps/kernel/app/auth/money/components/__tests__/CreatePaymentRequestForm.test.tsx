// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import CreatePaymentRequestForm from '../CreatePaymentRequestForm';

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: toastMock }),
  ConnectionPicker: ({ onSelect }: { onSelect: (c: { did: string; name: string | null; handle: string | null; avatar: string | null }) => void }) => (
    <button type="button" onClick={() => onSelect({ did: 'did:imajin:customer', name: 'Alice', handle: 'alice', avatar: null })}>
      Pick Alice
    </button>
  ),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const ISSUER_DID = 'did:imajin:business';

function installFetch(response: { ok: boolean; body: unknown }) {
  const spy = vi.fn(async () => ({ ok: response.ok, json: async () => response.body }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function fillFirstLineItem() {
  fireEvent.change(screen.getByPlaceholderText('Item name'), { target: { value: 'Consulting' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '19.99' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CreatePaymentRequestForm — validation', () => {
  it('shows an error when submitting with no line item name', async () => {
    installFetch({ ok: true, body: {} });
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Line item 1 needs a name')).toBeDefined();
  });

  it('shows an error when no recipient is selected in connection mode', async () => {
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Pick a connection to send this to')).toBeDefined();
  });

  it('shows an error when the invite email is empty in invite mode', async () => {
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByRole('tab', { name: 'Invite new' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Enter an email to invite')).toBeDefined();
  });
});

describe('CreatePaymentRequestForm — recipient mode: existing connection', () => {
  it('submits recipient_did for the selected connection', async () => {
    const spy = installFetch({
      ok: true,
      body: { id: 'pr_1', payHandle: 'ph_1', attestationId: 'att_1', fairManifest: { chain: [] } },
    });
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, init] = spy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.recipient_did).toBe('did:imajin:customer');
    expect(body.recipient_invite).toBeUndefined();
  });
});

describe('CreatePaymentRequestForm — recipient mode: invite new', () => {
  it('submits recipient_invite for a fresh email', async () => {
    const spy = installFetch({
      ok: true,
      body: { id: 'pr_2', payHandle: 'ph_2', attestationId: 'att_2', fairManifest: { chain: [] } },
    });
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByRole('tab', { name: 'Invite new' }));
    fireEvent.change(screen.getByPlaceholderText('customer@example.com'), { target: { value: 'customer@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, init] = spy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.recipient_invite).toEqual({ email: 'customer@example.com', delivery: 'email' });
    expect(body.recipient_did).toBeUndefined();
  });
});

describe('CreatePaymentRequestForm — after create', () => {
  it('shows the pay link and attestation id, then calls onCreated on Done', async () => {
    installFetch({
      ok: true,
      body: {
        id: 'pr_3',
        payHandle: 'ph_3',
        attestationId: 'att_3',
        fairManifest: { chain: [{ role: 'seller', share: 0.9 }] },
      },
    });
    const onCreated = vi.fn();
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={onCreated} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('att_3')).toBeDefined();
    expect(screen.getByText('https://pay.example/r/ph_3')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'pr_3' }));
  });

  it('surfaces the server error without crashing', async () => {
    installFetch({ ok: false, body: { error: 'recipient_did must be a DID the issuer has an existing connection with' } });
    render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);

    fillFirstLineItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('recipient_did must be a DID the issuer has an existing connection with')).toBeDefined();
  });
});
