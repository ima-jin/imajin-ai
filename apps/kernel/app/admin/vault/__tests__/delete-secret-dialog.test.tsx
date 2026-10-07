// @vitest-environment jsdom
/**
 * DeleteSecretDialog (#2698) — typed-confirmation gate (a mis-click must never
 * delete anything) plus the active-grantee warning: the COUNT is shown, grantee
 * identifiers and values never are.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DeleteSecretDialog } from '../delete-secret-dialog';

const FIELD = 'GITHUB-ORG-PROVISIONING';

interface GranteeRow {
  grantId: string;
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  expiresAt: string | null;
}

function installGranteesFetch(grantees: GranteeRow[] = []) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ field: FIELD, count: grantees.length, grantees }),
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function grantee(id: string): GranteeRow {
  return { grantId: `vdg_${id}`, grantedTo: `did:imajin:corpus-service-${id}`, purpose: 'corpus-sync', oneTime: false, expiresAt: null };
}

function renderDialog(overrides: Partial<Parameters<typeof DeleteSecretDialog>[0]> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <DeleteSecretDialog field={FIELD} open submitting={false} onClose={onClose} onConfirm={onConfirm} {...overrides} />,
  );
  return { onConfirm, onClose };
}

async function waitForGranteeCheck() {
  await waitFor(() => expect(screen.queryByText(/Checking for active grantees/)).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typed confirmation', () => {
  it('renders nothing when closed', () => {
    installGranteesFetch();
    render(<DeleteSecretDialog field={FIELD} open={false} submitting={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByText('Delete Secret')).toBeNull();
  });

  it('disables Delete until the grantee check resolves AND the field name is typed exactly', async () => {
    installGranteesFetch();
    renderDialog();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);

    await waitForGranteeCheck();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'github-org-provisioning' } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
  });

  it('only calls onConfirm once the typed text matches', async () => {
    installGranteesFetch();
    const { onConfirm } = renderDialog();
    await waitForGranteeCheck();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(FIELD);
  });

  it('cancel closes without confirming', () => {
    installGranteesFetch();
    const { onConfirm, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables Cancel and Delete and shows progress while submitting', async () => {
    installGranteesFetch();
    renderDialog({ submitting: true });
    expect(screen.getByRole('button', { name: 'Deleting…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    await waitForGranteeCheck();
  });
});

describe('active-grantee warning', () => {
  it('shows no warning when there are no active grantees', async () => {
    installGranteesFetch([]);
    renderDialog();
    await waitForGranteeCheck();
    expect(screen.queryByText(/will lose access/)).toBeNull();
  });

  it('warns with the singular count, never the grantee identity, and keeps Delete gated on the typed name', async () => {
    installGranteesFetch([grantee('abc123')]);
    renderDialog();

    await waitFor(() => expect(screen.getByText(/1 active grantee will lose access/)).toBeDefined());
    expect(screen.queryByText(/corpus-service-abc123/)).toBeNull();
    expect(screen.queryByText(/corpus-sync/)).toBeNull();

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/^Type GITHUB-ORG-PROVISIONING to confirm$/), { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
  });

  it('pluralises the count for several grantees', async () => {
    installGranteesFetch([grantee('a'), grantee('b'), grantee('c')]);
    renderDialog();
    await waitFor(() => expect(screen.getByText(/3 active grantees will lose access/)).toBeDefined());
  });

  it('treats a failed grantee check as unknown, not zero, and still requires the typed name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    const { onConfirm } = renderDialog();

    await waitFor(() => expect(screen.getByText(/Could not check for active grantees/)).toBeDefined());
    expect(screen.queryByText(/will lose access/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(FIELD);
  });
});
