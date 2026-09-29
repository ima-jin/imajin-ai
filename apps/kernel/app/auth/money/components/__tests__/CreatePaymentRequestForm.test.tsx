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

const PROFILE_URL_PREFIX = '/profile/api/profile/';
const CREATE_URL = '/pay/api/payment-requests';

/**
 * Stubs `fetch` for both calls the form makes: the profile read that loads
 * the issuer's tax registrations (#2421 — `GET /profile/api/profile/:did`,
 * always OK) and the create POST (answered with `response`).
 */
function installFetch(response: { ok: boolean; body: unknown }, profileBody: unknown = {}) {
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    const isProfile = url.startsWith(PROFILE_URL_PREFIX);
    return { ok: isProfile ? true : response.ok, json: async () => (isProfile ? profileBody : response.body) };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

type FetchSpy = ReturnType<typeof installFetch>;

function createCall(spy: FetchSpy) {
  return spy.mock.calls.find(([url]) => url === CREATE_URL);
}

async function postedBody(spy: FetchSpy): Promise<Record<string, unknown>> {
  await waitFor(() => expect(createCall(spy)).toBeDefined());
  const [, init] = createCall(spy)!;
  return JSON.parse((init as RequestInit).body as string);
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

    const body = await postedBody(spy);
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

    const body = await postedBody(spy);
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

const REG_ON = { jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' };
const REG_QC_QST = { jurisdiction: 'CA-QC', kind: 'QST', number: '1234567890TQ0001' };
const REG_BC_GST = { jurisdiction: 'CA-BC', kind: 'GST/HST', number: '987654321RT0001' };
const REG_BC_PST = { jurisdiction: 'CA-BC', kind: 'PST', number: '12345678' };

const CREATED = { ok: true, body: { id: 'pr_t', payHandle: 'ph_t', attestationId: 'att_t', fairManifest: { chain: [] } } };

function fillHundredDollarItem() {
  fireEvent.change(screen.getByPlaceholderText('Item name'), { target: { value: 'Consulting' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100.00' } });
}

async function renderWithRegistrations(registrations: unknown[], response = CREATED) {
  const spy = installFetch(response, { taxRegistrations: registrations });
  render(<CreatePaymentRequestForm issuerDid={ISSUER_DID} onCreated={vi.fn()} onCancel={vi.fn()} />);
  await waitFor(() => expect(spy.mock.calls.some(([url]) => url === `${PROFILE_URL_PREFIX}${encodeURIComponent(ISSUER_DID)}`)).toBe(true));
  return spy;
}

describe('CreatePaymentRequestForm — Charge tax (#2421)', () => {
  it('reads registrations through the profile read path and defaults Charge tax ON when the issuer has one', async () => {
    await renderWithRegistrations([REG_ON]);

    const toggle = (await screen.findByLabelText('Charge tax')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(toggle.disabled).toBe(false);
  });

  it('prefills the rate from the issuer registration (ON GST/HST = 13) and keeps it editable', async () => {
    await renderWithRegistrations([REG_ON]);

    const rate = (await screen.findByLabelText('Rate for GST/HST (CA-ON), percent')) as HTMLInputElement;
    expect(rate.value).toBe('13');
    fireEvent.change(rate, { target: { value: '12' } });
    expect(rate.value).toBe('12');
  });

  it('shows subtotal, tax rate, tax amount and total while the toggle is ON', async () => {
    await renderWithRegistrations([REG_ON]);
    await screen.findByLabelText('Rate for GST/HST (CA-ON), percent');

    fillHundredDollarItem();

    const summary = (await screen.findByTestId('tax-summary')).textContent ?? '';
    expect(summary).toContain('Subtotal');
    expect(summary).toContain('100.00');
    expect(summary).toContain('Tax rate');
    expect(summary).toContain('GST/HST 13%');
    expect(summary).toContain('Tax amount');
    expect(summary).toContain('13.00');
    expect(summary).toContain('Total');
    expect(summary).toContain('113.00');
  });

  it('recomputes the preview when the rate is edited', async () => {
    await renderWithRegistrations([REG_ON]);
    const rate = await screen.findByLabelText('Rate for GST/HST (CA-ON), percent');
    fillHundredDollarItem();
    await screen.findByTestId('tax-summary');

    fireEvent.change(rate, { target: { value: '5' } });

    await waitFor(() => expect(screen.getByTestId('tax-summary').textContent).toContain('105.00'));
    expect(screen.getByTestId('tax-summary').textContent).toContain('GST/HST 5%');
  });

  it('submits charge_tax, one taxes[] row per charged registration, and the previewed subtotal/tax/total', async () => {
    const spy = await renderWithRegistrations([REG_ON]);
    await screen.findByLabelText('Rate for GST/HST (CA-ON), percent');
    fillHundredDollarItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const body = await postedBody(spy);
    expect(body).toMatchObject({
      charge_tax: true,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300, amount: 1300 }],
      subtotal_amount: 10_000,
      tax_total_amount: 1300,
      total_amount: 11_300,
    });
    // The registration number is never sent — the server reads it from the profile.
    expect(JSON.stringify(body)).not.toContain('123456789RT0001');
  });

  it('with no registration on the profile: the toggle is off + disabled, a hint explains why, and no tax fields are sent', async () => {
    const spy = await renderWithRegistrations([]);

    const toggle = (await screen.findByLabelText('Charge tax')) as HTMLInputElement;
    await waitFor(() => expect(screen.getByText(/Add a tax registration on your business profile/)).toBeDefined());
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);

    fillHundredDollarItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const body = await postedBody(spy);
    expect(body).not.toHaveProperty('charge_tax');
    expect(body).not.toHaveProperty('taxes');
    expect(body).not.toHaveProperty('total_amount');
  });

  it('turning the toggle OFF sends a body with no tax fields', async () => {
    const spy = await renderWithRegistrations([REG_ON]);
    const toggle = (await screen.findByLabelText('Charge tax')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));

    fireEvent.click(toggle);
    expect(screen.queryByTestId('tax-summary')).toBeNull();

    fillHundredDollarItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const body = await postedBody(spy);
    expect(body).not.toHaveProperty('charge_tax');
    expect(body).not.toHaveProperty('taxes');
  });

  it('QC QST (9.975% \u2014 not an integer bps) has no prefill: blank rate, required, and 9.975 is refused rather than rounded', async () => {
    const spy = await renderWithRegistrations([REG_QC_QST]);
    const rate = (await screen.findByLabelText('Rate for QST (CA-QC), percent')) as HTMLInputElement;
    expect(rate.value).toBe('');

    fillHundredDollarItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Shown live in the tax summary and, on Send, in the error banner.
    expect(await screen.findAllByText('Enter a rate for QST (CA-QC)')).toHaveLength(2);

    fireEvent.change(rate, { target: { value: '9.975' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findAllByText(/not a whole number of basis points/)).toHaveLength(2);
    expect(createCall(spy)).toBeUndefined();

    fireEvent.change(rate, { target: { value: '9.97' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const body = await postedBody(spy);
    expect(body).toMatchObject({ taxes: [{ kind: 'QST', rate_bps: 997 }] });
  });

  it('multiple registrations (BC GST + PST): one row each, and un-ticking one drops its row', async () => {
    const spy = await renderWithRegistrations([REG_BC_GST, REG_BC_PST]);
    await screen.findByLabelText('Rate for GST/HST (CA-BC), percent');
    expect((screen.getByLabelText('Rate for PST (CA-BC), percent') as HTMLInputElement).value).toBe('7');
    fillHundredDollarItem();

    const summary = (await screen.findByTestId('tax-summary')).textContent ?? '';
    expect(summary).toContain('GST/HST 5% + PST 7%');
    expect(summary).toContain('12.00'); // 5.00 + 7.00
    expect(summary).toContain('112.00');

    fireEvent.click(screen.getByLabelText(/PST \(CA-BC\)/, { selector: 'input[type="checkbox"]' }));
    await waitFor(() => expect(screen.getByTestId('tax-summary').textContent).toContain('105.00'));

    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const body = await postedBody(spy);
    expect(body.taxes).toEqual([{ jurisdiction: 'CA-BC', kind: 'GST/HST', rate_bps: 500, amount: 500 }]);
    expect(body).toMatchObject({ tax_total_amount: 500, total_amount: 10_500 });
  });

  it('surfaces a server-side tax rejection without crashing', async () => {
    await renderWithRegistrations([REG_ON], { ok: false, body: { error: 'taxes[0].amount (1) does not match the recomputed GST/HST amount (1300)' } } as never);
    await screen.findByLabelText('Rate for GST/HST (CA-ON), percent');
    fillHundredDollarItem();
    fireEvent.click(screen.getByText('Pick Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/does not match the recomputed GST\/HST amount/)).toBeDefined();
  });
});
