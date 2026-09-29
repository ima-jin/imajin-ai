// @vitest-environment jsdom
/**
 * DeleteSecretDialog (#2445 defect 5, #2450 step 1) — typed confirmation
 * gate: a mis-click on the row's Delete button must never itself tombstone
 * anything. Also pins the "N active grantees will need re-issue" warning
 * (#2450): deleting a field does nothing to any OTHER active grantee's
 * copy of the wrapped key.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DeleteSecretDialog } from '../delete-secret-dialog';

const FIELD = 'GITHUB-ORG-PROVISIONING';

function installGranteesFetch(grantees: Array<{ grantedTo: string; purpose: string | null; oneTime: boolean; expiresAt: string | null }> = []) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ field: FIELD, count: grantees.length, grantees }),
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderDialog(overrides: Partial<Parameters<typeof DeleteSecretDialog>[0]> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <DeleteSecretDialog field={FIELD} open submitting={false} onClose={onClose} onConfirm={onConfirm} {...overrides} />,
  );
  return { onConfirm, onClose };
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
    expect(screen.queryByText('Delete Vault Entry')).toBeNull();
  });

  it('disables Delete until the field name is typed exactly', () => {
    installGranteesFetch();
    renderDialog();
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'github-org-provisioning' } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
  });

  it('only calls onConfirm once the typed text matches', async () => {
    installGranteesFetch();
    const { onConfirm } = renderDialog();

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
});

describe('other-grantee warning (#2450)', () => {
  it('shows no warning and requires no extra step when there are no other grantees', async () => {
    installGranteesFetch([]);
    renderDialog();

    await waitFor(() => expect(screen.queryByText(/will need re-issue/)).toBeNull());
  });

  it('warns with the count and each grantee, and keeps Delete gated on the typed field name', async () => {
    installGranteesFetch([
      { grantedTo: 'did:imajin:corpus-service-abc123', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
    ]);
    renderDialog();

    await waitFor(() => expect(screen.getByText(/1 active grantee will need re-issue/)).toBeDefined());
    expect(screen.getByText(/corpus-sync/)).toBeDefined();
    expect(screen.getByText(/stop decrypting/)).toBeDefined();

    // The warning does not add its own gate — the existing typed-field-name
    // confirmation already blocks Delete regardless of grantee count.
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/^Type GITHUB-ORG-PROVISIONING to confirm$/), { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
  });
});
