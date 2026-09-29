// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TaxRegistrationsTab from '../TaxRegistrationsTab';

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: toastMock }),
}));

const PROFILE_DID = 'did:imajin:biz';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetch(
  initialTaxRegistrations: unknown[],
  putResponder?: (body: Record<string, unknown>) => { ok: boolean; body: Record<string, unknown> }
) {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (!init || init.method === undefined) {
      // GET
      return { ok: true, json: async () => ({ did: PROFILE_DID, taxRegistrations: initialTaxRegistrations }) };
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      const result = putResponder
        ? putResponder(body)
        : { ok: true, body: { did: PROFILE_DID, taxRegistrations: body.taxRegistrations } };
      return { ok: result.ok, json: async () => result.body };
    }
    throw new Error(`Unexpected fetch: ${init.method}`);
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TaxRegistrationsTab — list', () => {
  it('shows the empty state when there are no registrations', async () => {
    installFetch([]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);

    expect(await screen.findByText('No tax registrations on file.')).toBeDefined();
  });

  it('renders existing registrations from the profile', async () => {
    installFetch([{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001', label: 'Head office' }]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);

    expect(await screen.findByText('GST/HST · CA-ON')).toBeDefined();
    expect(screen.getByText('123456789RT0001')).toBeDefined();
    expect(screen.getByText('Head office')).toBeDefined();
  });
});

describe('TaxRegistrationsTab — add flow', () => {
  it('adds a valid registration and saves the appended array', async () => {
    const { calls } = installFetch([]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);
    await screen.findByText('No tax registrations on file.');

    fireEvent.click(screen.getByRole('button', { name: '+ Add registration' }));
    fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'CA-ON' } });
    fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: '123-456-789-RT-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Tax registration added'));

    const putCall = calls.find((c) => c.init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall!.init!.body as string);
    // The client validates+normalises before sending, same shape the server would persist.
    expect(body.taxRegistrations).toEqual([{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }]);

    expect(await screen.findByText('GST/HST · CA-ON')).toBeDefined();
  });

  it('shows an inline format error and does not save when the number is invalid', async () => {
    const { calls } = installFetch([]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);
    await screen.findByText('No tax registrations on file.');

    fireEvent.click(screen.getByRole('button', { name: '+ Add registration' }));
    fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'CA-ON' } });
    fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(/9 digits/)).toBeDefined();
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
    expect(screen.getByText('No tax registrations on file.')).toBeDefined();
  });

  it('shows an inline error when the jurisdiction is missing', async () => {
    installFetch([]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);
    await screen.findByText('No tax registrations on file.');

    fireEvent.click(screen.getByRole('button', { name: '+ Add registration' }));
    fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: '123456789RT0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(/jurisdiction is required/)).toBeDefined();
  });

  it('surfaces a server-side error via a toast and keeps the draft open', async () => {
    installFetch([], () => ({ ok: false, body: { error: 'taxRegistrations can only be set on a business identity' } }));
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);
    await screen.findByText('No tax registrations on file.');

    fireEvent.click(screen.getByRole('button', { name: '+ Add registration' }));
    fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'CA-ON' } });
    fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: '123456789RT0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('taxRegistrations can only be set on a business identity')
    );
    // The form stays open on failure so the user doesn't lose their input.
    expect(screen.getByLabelText('Jurisdiction')).toBeDefined();
  });
});

describe('TaxRegistrationsTab — remove flow', () => {
  it('removes a registration and saves the remaining array', async () => {
    const { calls } = installFetch([{ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' }]);
    render(<TaxRegistrationsTab profileDid={PROFILE_DID} />);
    await screen.findByText('GST/HST · CA-ON');

    fireEvent.click(screen.getByRole('button', { name: 'Remove GST/HST registration for CA-ON' }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Tax registration removed'));

    const putCall = calls.find((c) => c.init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall!.init!.body as string);
    expect(body.taxRegistrations).toEqual([]);

    expect(await screen.findByText('No tax registrations on file.')).toBeDefined();
  });
});
