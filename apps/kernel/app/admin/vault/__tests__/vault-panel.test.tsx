// @vitest-environment jsdom
/**
 * VaultPanel (#2445, #2450) — component-level add→list→delete walkthrough,
 * mirroring the manual operator walkthrough this issue required before
 * marking the PR ready: add `github-org-provisioning` through the dialog
 * (no case transform), see it listed with the right custody, then delete
 * it from the panel with typed confirmation. Also covers the #2450 review
 * fixes: a real-DID-shaped connector field, the wrong-custody badge, and
 * internal-secret:* rows hiding Add/Delete.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { VaultPanel } from '../vault-panel';

const FIELD = 'github-org-provisioning';

interface MockVaultRow {
  field: string;
  hint: string;
  cid: string;
  senderDid: string;
  timestamp: string;
  status: 'active' | 'deleted';
  custodyScheme: 'node-sealed' | 'delegation-grant';
}

interface MockKnownField {
  field: string;
  description: string;
  requiredCustody?: 'node-sealed' | 'delegation-grant';
  why?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function installFetch(rows: MockVaultRow[] = [], knownFields: MockKnownField[] = []) {
  let listRows = [...rows];

  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === '/api/vault/list' && method === 'GET') {
      return jsonResponse(listRows);
    }
    if (url === '/api/vault/known-fields' && method === 'GET') {
      return jsonResponse({ fields: knownFields });
    }
    if (url.startsWith('/api/vault/grantees/') && method === 'GET') {
      return jsonResponse({ field: decodeURIComponent(url.split('/').pop() ?? ''), count: 0, grantees: [] });
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

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('add -> list -> delete', () => {
  it('adds github-org-provisioning without uppercasing it, lists it with delegation-grant custody, then deletes it', async () => {
    installFetch();
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getByText('No secrets found yet.')).toBeDefined());

    // Open the add dialog and submit the exact field from the issue's acceptance criteria.
    fireEvent.click(screen.getByRole('button', { name: '+ Set Secret' }));
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: FIELD } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Secret/ }));

    // Listed exactly as typed — never uppercased — with delegation-grant custody
    // (github-org-provisioning is locked to it, see field-grammar.ts).
    await waitFor(() => expect(screen.getAllByText(FIELD).length).toBeGreaterThan(0));
    expect(screen.queryByText(FIELD.toUpperCase())).toBeNull();
    expect(screen.queryAllByText('node-sealed').length).toBe(0);
    expect(screen.getAllByText('delegation-grant').length).toBeGreaterThan(0);

    // Delete it back out via typed confirmation.
    fireEvent.click(screen.getAllByLabelText(`Delete ${FIELD}`)[0]);
    await waitFor(() => expect(screen.queryByText(/Checking for other active grantees/)).toBeNull());
    const confirmInput = screen.getByLabelText(new RegExp(`Type ${FIELD} to confirm`));
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toHaveProperty('disabled', true);

    fireEvent.change(confirmInput, { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryAllByText(FIELD).length).toBe(0));
    expect(screen.getByText('No secrets found yet.')).toBeDefined();
  });

  it('accepts a connector field with a real, mixed-case DID (#2450) — never rejected, never lowercased', async () => {
    installFetch();
    render(<VaultPanel />);
    await waitFor(() => expect(screen.getByText('No secrets found yet.')).toBeDefined());

    const connectorField = 'warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT';
    fireEvent.click(screen.getByRole('button', { name: '+ Set Secret' }));
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: connectorField } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: /Save Secret/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: /Save Secret/ }));

    await waitFor(() => expect(screen.getAllByText(connectorField).length).toBeGreaterThan(0));
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

describe('wrong-custody badge (#2450 review item 4)', () => {
  it('shows 🟡 wrong custody — not 🟢 sealed — for a known field sealed with the wrong scheme', async () => {
    installFetch(
      [
        {
          field: FIELD,
          hint: 'ghpk',
          cid: 'cid:1',
          senderDid: 'did:imajin:node',
          timestamp: new Date().toISOString(),
          status: 'active',
          custodyScheme: 'node-sealed', // the exact prod state before #2445
        },
      ],
      [{ field: FIELD, description: 'Org-scoped GitHub App credential.', requiredCustody: 'delegation-grant', why: 'loadOrgCredential needs v2.' }],
    );
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getAllByText(/🟡 wrong custody/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/🟢 sealed/)).toBeNull();
    // Present (even with the wrong custody), so it must not also render as a missing row.
    expect(screen.queryByText(/🔴 missing/)).toBeNull();
  });
});

describe('internal-secret:* rows hide Add/Delete (#2450 DECISION a)', () => {
  it('shows an unsealed internal-secret:* known field as self-provisioned, with no Add button', async () => {
    installFetch(
      [],
      [{ field: 'internal-secret:kernel.foreign-principal-pepper', description: 'HMAC pepper.', requiredCustody: 'delegation-grant' }],
    );
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getAllByText(/kernel provisions on boot/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/🔴 missing/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('hides the Delete action on an already-sealed internal-secret:* row', async () => {
    installFetch([
      {
        field: 'internal-secret:kernel.foreign-principal-pepper',
        hint: 'abcd',
        cid: 'cid:1',
        senderDid: 'did:imajin:node',
        timestamp: new Date().toISOString(),
        status: 'active',
        custodyScheme: 'delegation-grant',
      },
    ]);
    render(<VaultPanel />);

    await waitFor(() => expect(screen.getAllByText('internal-secret:kernel.foreign-principal-pepper').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Delete internal-secret:kernel.foreign-principal-pepper')).toBeNull();
    // Rotate must still be offered — it's the only way to replace this field.
    expect(screen.getAllByRole('button', { name: 'Rotate' }).length).toBeGreaterThan(0);
  });
});
