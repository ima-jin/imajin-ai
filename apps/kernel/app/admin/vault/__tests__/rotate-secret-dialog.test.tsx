// @vitest-environment jsdom
/**
 * RotateSecretDialog (#2450 step 1) — rotating re-seals under a new key and
 * only re-grants the node's own self-grant; any OTHER active grantee's copy
 * of the wrapped key silently stops decrypting. Pins that a rotate with
 * zero other grantees behaves exactly as before, and a rotate with N>0
 * shows the count + list and blocks Rotate until the operator types the
 * field name to confirm.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RotateSecretDialog } from '../rotate-secret-dialog';

const FIELD = 'warp-agent-key:did:imajin:node-abc123';

function installGranteesFetch(
  grantees: Array<{ grantId: string; grantedTo: string; purpose: string | null; oneTime: boolean; expiresAt: string | null }> = [],
  extra: { reissuedOnRotate?: boolean } = {},
) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ field: FIELD, count: grantees.length, grantees, ...extra }),
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderDialog(overrides: Partial<Parameters<typeof RotateSecretDialog>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <RotateSecretDialog field={FIELD} open submitting={false} onClose={onClose} onSubmit={onSubmit} {...overrides} />,
  );
  return { onSubmit, onClose };
}

function valueInput(): HTMLInputElement {
  return screen.getByLabelText('New value') as HTMLInputElement;
}

function rotateButton(): HTMLElement {
  return screen.getByRole('button', { name: /Rotate/ });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('no other grantees', () => {
  it('rotates with just a new value — no extra confirmation required', async () => {
    installGranteesFetch([]);
    const { onSubmit } = renderDialog();

    await waitFor(() => expect(screen.queryByText(/will need re-issue/)).toBeNull());

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', false);

    fireEvent.click(rotateButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ field: FIELD, value: 'new-secret-value' }));
  });
});

describe('N>0 other grantees (#2450)', () => {
  it('shows the count and each grantee, and blocks Rotate until the field name is typed', async () => {
    installGranteesFetch([
      { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus-service-abc123', purpose: 'corpus-sync', oneTime: false, expiresAt: null },
      { grantId: 'vdg_2', grantedTo: 'did:imajin:warp-runner-xyz789', purpose: null, oneTime: true, expiresAt: null },
    ]);
    const { onSubmit } = renderDialog();

    await waitFor(() => expect(screen.getByText(/2 active grantees will need re-issue/)).toBeDefined());
    expect(screen.getByText(/corpus-sync/)).toBeDefined();
    expect(screen.getByText(/stop decrypting/)).toBeDefined();

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', true);

    fireEvent.click(rotateButton());
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    expect(rotateButton()).toHaveProperty('disabled', false);

    fireEvent.click(rotateButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ field: FIELD, value: 'new-secret-value' }));
  });

  it('re-locks the confirmation gate if the dialog is reopened', async () => {
    installGranteesFetch([{ grantId: 'vdg_1', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null }]);
    const { rerender } = render(
      <RotateSecretDialog field={FIELD} open submitting={false} onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText(/will need re-issue/)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: FIELD } });
    expect(rotateButton()).toHaveProperty('disabled', true); // still needs a value

    rerender(<RotateSecretDialog field={null} open={false} submitting={false} onClose={vi.fn()} onSubmit={vi.fn()} />);
    rerender(<RotateSecretDialog field={FIELD} open submitting={false} onClose={vi.fn()} onSubmit={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/will need re-issue/)).toBeDefined());
    fireEvent.change(valueInput(), { target: { value: 'x' } });
    expect(rotateButton()).toHaveProperty('disabled', true); // confirm text was reset on close
  });
});

describe('internal-secret:* field (exempt — rotate re-issues grantees, #2450)', () => {
  const INTERNAL_FIELD = 'internal-secret:kernel.attestation-internal-api-key';

  it('needs no typed confirmation, shows no warning, and says grantees are re-issued automatically', async () => {
    installGranteesFetch([], { reissuedOnRotate: true });
    const { onSubmit } = renderDialog({ field: INTERNAL_FIELD });

    await waitFor(() => expect(screen.getByText(/re-issued automatically/)).toBeDefined());
    expect(screen.queryByText(/will need re-issue/)).toBeNull();
    expect(screen.queryByText(/not do that automatically yet/)).toBeNull();
    expect(screen.queryByLabelText(/Type/)).toBeNull();

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', false);

    fireEvent.click(rotateButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [input] = onSubmit.mock.calls[0];
    expect(input).toMatchObject({ field: INTERNAL_FIELD, value: 'new-secret-value' });
    expect(input).not.toHaveProperty('confirmField');
  });

  it('does not show the auto-reissue note for a guarded (non-exempt) field', async () => {
    installGranteesFetch([], { reissuedOnRotate: false });
    renderDialog();

    await waitFor(() => expect(screen.queryByText(/Checking for other active grantees/)).toBeNull());
    expect(screen.queryByText(/re-issued automatically/)).toBeNull();
  });
});
