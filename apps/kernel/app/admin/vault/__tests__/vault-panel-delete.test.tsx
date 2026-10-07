// @vitest-environment jsdom
/**
 * /admin/vault Delete Secret wiring (#2698): the button is offered on every row
 * except internal-secret:*, the dialog gates the request, the request carries
 * the explicit confirmation, and a successful delete drops the row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { VaultPanel } from '../vault-panel';

const NODE_DID = 'did:imajin:node';
const FIELD = 'github-org-provisioning';
const INTERNAL = 'internal-secret:kernel.attestation-internal-api-key';

const row = (field: string) => ({
  field,
  hint: 'abcd',
  cid: `cid-${field}`,
  senderDid: NODE_DID,
  timestamp: '2026-09-29T12:00:00.000Z',
  status: 'active',
  custodyScheme: 'node-sealed',
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function installFetch(listRows: unknown[], deleteResponse: Response = jsonResponse(200, { ok: true })) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/vault/list') return jsonResponse(200, listRows);
    if (url.startsWith('/api/vault/grantees/')) return jsonResponse(200, { count: 0, grantees: [], reissuedOnRotate: true });
    if (url === '/api/vault/delete' && init?.method === 'DELETE') return deleteResponse;
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function deleteCalls(spy: ReturnType<typeof installFetch>) {
  return spy.mock.calls.filter(([url]) => url === '/api/vault/delete');
}

async function renderLoaded() {
  render(<VaultPanel />);
  await waitFor(() => expect(screen.queryByText('Loading vault entries…')).toBeNull());
}

async function confirmDeleteOf(field: string) {
  // Each row renders twice (desktop table + mobile card); either button opens the dialog.
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  await waitFor(() => expect(screen.queryByText(/Checking for active grantees/)).toBeNull());
  fireEvent.change(screen.getByLabelText(/^Type .* to confirm$/), { target: { value: field } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Delete button visibility', () => {
  it('is offered on ordinary rows but never on internal-secret:* rows', async () => {
    installFetch([row(FIELD), row(INTERNAL)]);
    await renderLoaded();
    // One ordinary row, rendered twice (desktop + mobile).
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
  });

  it('shows no Delete at all when the only row is internal-secret:*', async () => {
    installFetch([row(INTERNAL)]);
    await renderLoaded();
    expect(screen.queryAllByRole('button', { name: 'Delete' })).toHaveLength(0);
  });
});

describe('Delete flow', () => {
  it('sends nothing until the dialog is confirmed, then DELETEs with confirmField and removes the row', async () => {
    const spy = installFetch([row(FIELD)]);
    await renderLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(deleteCalls(spy)).toHaveLength(0);

    await waitFor(() => expect(screen.queryByText(/Checking for active grantees/)).toBeNull());
    fireEvent.change(screen.getByLabelText(/^Type .* to confirm$/), { target: { value: FIELD } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);

    await waitFor(() => expect(deleteCalls(spy)).toHaveLength(1));
    const init = deleteCalls(spy)[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ field: FIELD, confirmField: FIELD });

    await waitFor(() => expect(screen.queryAllByText(FIELD)).toHaveLength(0));
  });

  it('surfaces a server refusal, keeps the row, and closes the dialog', async () => {
    const spy = installFetch(
      [row(FIELD)],
      jsonResponse(409, { error: '2 active grantee(s) hold a grant', code: 'GRANTEE_CONFIRMATION_REQUIRED' }),
    );
    await renderLoaded();
    await confirmDeleteOf(FIELD);

    await waitFor(() => expect(screen.getByText(/2 active grantee\(s\) hold a grant/)).toBeDefined());
    expect(deleteCalls(spy)).toHaveLength(1);
    expect(screen.getAllByText(FIELD).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/^Type .* to confirm$/)).toBeNull();
  });
});
