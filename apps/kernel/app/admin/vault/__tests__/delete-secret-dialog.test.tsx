// @vitest-environment jsdom
/**
 * DeleteSecretDialog (#2445 defect 5) — typed confirmation gate: a mis-click
 * on the row's Delete button must never itself tombstone anything.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DeleteSecretDialog } from '../delete-secret-dialog';

const FIELD = 'GITHUB-ORG-PROVISIONING';

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
  vi.restoreAllMocks();
});

describe('typed confirmation', () => {
  it('renders nothing when closed', () => {
    render(<DeleteSecretDialog field={FIELD} open={false} submitting={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByText('Delete Vault Entry')).toBeNull();
  });

  it('disables Delete until the field name is typed exactly', () => {
    renderDialog();
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'github-org-provisioning' } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', false);
  });

  it('only calls onConfirm once the typed text matches', async () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(FIELD);
  });

  it('cancel closes without confirming', () => {
    const { onConfirm, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
