// @vitest-environment jsdom
/**
 * VaultPanel (#2445) — component-level add→list→delete walkthrough with a
 * namespaced field name, mirroring the manual operator walkthrough this
 * issue required before marking the PR ready: add a lowercase-hyphen field
 * through the dialog (no case transform), see it listed with the right
 * custody, then delete it from the panel with typed confirmation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { VaultPanel } from '../vault-panel';

const FIELD = 'internal-secret:kernel.foreign-principal-pepper';

interface MockVaultRow {
  field: string;
  hint: string;
  cid: string;
  senderDid: string;
  timestamp: string;
  status: 'active' | 'deleted';
  custodyScheme: 'node-sealed' | 'delegation-grant';
}

function installFetch(rows: MockVaultRow[] = []) {
  let listRows = [...rows];

  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === '/api/vault/list' && method === 'GET') {
      return jsonResponse(listRows);
    }
    if (url === '/api/vault/known-fields' && method === 'GET') {
      return jsonResponse({ fields: [] });
    }
    if (url === '/api/vault/set' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { field: string; value: string; custodyScheme: string };
      const nowRow: MockVaultRow = {
        field: body.field,
        hint: 'stub',
        cid: 'cid:new',
        senderDid: 'did:imajin:node',
        timestamp: new Date().toISOString(),
        status: 'active',
        custodyScheme: body.custodyScheme as MockVaultRow['custodyScheme'],
      };
      listRows = [nowRow, ...listRows.filter((row) => row.field !== body.field)];
      return jsonResponse({
        field: body.field,
        cid: nowRow.cid,
        timestamp: nowRow.timestamp,
        senderDid: nowRow.senderDid,
        status: 'confirmed',
        custodyScheme: body.custodyScheme,
      });
    }
    if (url === '/api/vault/delete' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { field: string };
      const existed = listRows.some((row) => row.field === body.field);
      listRows = listRows.filter((row) => row.field !== body.field);
      if (!existed) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      return jsonResponse({ ok: true, field: body.field, cid: 'cid:tombstone', timestamp: new Date().toISOString() });
    }

    throw new Error(`Unhandled fetch in test: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('add -> list -> delete, namespaced field', () => {
  it('adds a namespaced field without uppercasing it, lists it with delegation-grant custody, then deletes it', async () => {
    installFetch();
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getByText('No secrets found yet.')).toBeDefined());

    // Open the add dialog and submit a namespaced, lowercase field name.
    fireEvent.click(screen.getByRole('button', { name: '+ Set Secret' }));
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: FIELD } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Secret/ }));

    // Listed exactly as typed — never uppercased — with delegation-grant custody
    // (internal-secret:* is locked to it, see field-grammar.ts).
    await waitFor(() => expect(screen.getAllByText(FIELD).length).toBeGreaterThan(0));
    expect(screen.queryByText(FIELD.toUpperCase())).toBeNull();
    expect(screen.queryAllByText('node-sealed').length).toBe(0);
    expect(screen.getAllByText('delegation-grant').length).toBeGreaterThan(0);

    // Delete it back out via typed confirmation.
    fireEvent.click(screen.getAllByLabelText(`Delete ${FIELD}`)[0]);
    const confirmInput = screen.getByLabelText(new RegExp(`Type ${FIELD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to confirm`));
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toHaveProperty('disabled', true);

    fireEvent.change(confirmInput, { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryAllByText(FIELD).length).toBe(0));
    expect(screen.getByText('No secrets found yet.')).toBeDefined();
  });
});

describe('honest status badge (#2445 defect 3)', () => {
  it('shows a node-sealed field as sealed, with no pending heuristic', async () => {
    installFetch([
      {
        field: 'GH_TOKEN',
        hint: 'ghp_',
        cid: 'cid:1',
        senderDid: 'did:imajin:node',
        timestamp: new Date().toISOString(),
        status: 'active',
        custodyScheme: 'node-sealed',
      },
    ]);
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getAllByText('GH_TOKEN').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/🟢 sealed/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/pending/)).toBeNull();
  });
});
