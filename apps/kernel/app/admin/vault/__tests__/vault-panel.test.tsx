// @vitest-environment jsdom
/**
 * /admin/vault Set Secret + status badge (#2445).
 *
 * Pins the operator's-seat acceptance: a namespaced field is stored exactly as
 * typed, custody is chosen at add (delegation-grant by default for a namespaced
 * field), and a row is only 🟡 pending when an operator action exists. A field
 * name outside the grammar is refused in the dialog and never reaches the server.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { VaultPanel } from '../vault-panel';

const NODE_DID = 'did:imajin:node';
const FIELD = 'github-org-provisioning';

const node = (field: string) => ({
  field,
  hint: 'abcd',
  cid: `cid-${field}`,
  senderDid: NODE_DID,
  timestamp: '2026-09-29T12:00:00.000Z',
  status: 'active',
  custodyScheme: 'node-sealed',
});

const granted = (field: string, grantStatus: 'active' | 'none') => ({
  ...node(field),
  custodyScheme: 'delegation-grant',
  grantedTo: NODE_DID,
  expiresAt: null,
  grantStatus,
});

function installFetch(listRows: unknown[]) {
  const spy = vi.fn(async (url: string) => {
    if (url === '/api/vault/list') return { ok: true, status: 200, json: async () => listRows } as Response;
    if (url === '/api/vault/set') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ field: FIELD, cid: 'cid-new', timestamp: '2026-09-30T12:00:00.000Z', senderDid: NODE_DID, status: 'confirmed' }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function openSetDialog() {
  render(<VaultPanel />);
  await waitFor(() => expect(screen.queryByText('Loading vault entries…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '+ Set Secret' }));
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function setCalls(spy: ReturnType<typeof installFetch>) {
  return spy.mock.calls.filter(([url]) => url === '/api/vault/set');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Set Secret dialog', () => {
  it('seals a namespaced field as typed, as delegation-grant by default', async () => {
    const spy = installFetch([]);
    await openSetDialog();

    fill('Field', FIELD);
    fill('Value', '{"appId":"1"}');
    expect((screen.getByLabelText('Custody') as HTMLSelectElement).value).toBe('delegation-grant');
    fireEvent.click(screen.getByRole('button', { name: 'Save Secret' }));

    await waitFor(() => expect(setCalls(spy)).toHaveLength(1));
    const body = JSON.parse((setCalls(spy)[0][1] as RequestInit).body as string);
    expect(body).toEqual({ field: FIELD, value: '{"appId":"1"}', custodyScheme: 'delegation-grant' });
  });

  it('lets the operator override custody, and defaults ENV_STYLE names to node-sealed', async () => {
    const spy = installFetch([]);
    await openSetDialog();

    fill('Field', 'GH_TOKEN');
    expect((screen.getByLabelText('Custody') as HTMLSelectElement).value).toBe('node-sealed');
    fireEvent.change(screen.getByLabelText('Custody'), { target: { value: 'delegation-grant' } });
    fill('Value', 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Save Secret' }));

    await waitFor(() => expect(setCalls(spy)).toHaveLength(1));
    const body = JSON.parse((setCalls(spy)[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ field: 'GH_TOKEN', custodyScheme: 'delegation-grant' });
  });

  it('refuses a field outside the grammar without calling the server', async () => {
    const spy = installFetch([]);
    await openSetDialog();

    fill('Field', 'bad field!');
    fill('Value', 'secret');

    expect(screen.getByRole('alert')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save Secret' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form') as HTMLFormElement);
    expect(setCalls(spy)).toHaveLength(0);
  });
});

describe('status badge', () => {
  it('is confirmed for every entry the running kernel can read, pending only with an operator action and a hover', async () => {
    installFetch([node('GH_TOKEN'), granted(FIELD, 'active'), granted('revoked-field', 'none')]);
    render(<VaultPanel />);
    await waitFor(() => expect(screen.queryByText('Loading vault entries…')).toBeNull());

    const confirmed = screen.getAllByText('🟢 confirmed');
    // Each row renders twice (desktop table + mobile card): 2 confirmed rows, 1 pending row.
    expect(confirmed).toHaveLength(4);
    const pending = screen.getAllByText('🟡 pending');
    expect(pending).toHaveLength(2);
    pending.forEach((el) => expect(el.getAttribute('title')).toMatch(/Rotate/));
    confirmed.forEach((el) => expect(el.getAttribute('title')).toBeTruthy());
  });
});
