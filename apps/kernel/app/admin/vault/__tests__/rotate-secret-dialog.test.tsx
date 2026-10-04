// @vitest-environment jsdom
/**
 * RotateSecretDialog (#2450 step 1) — rotating re-seals under a new key, so
 * every OTHER active grantee's copy of the wrapped key would stop decrypting.
 * The server re-issues them on rotate; the dialog lists who is affected and
 * only blocks Rotate when the server cannot re-issue (Tier 1 custody) or the
 * grantee lookup failed (unknown is never treated as zero).
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

    await waitFor(() => expect(screen.queryByText(/will be re-issued/)).toBeNull());

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', false);

    fireEvent.click(rotateButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ field: FIELD, value: 'new-secret-value' }));
  });
});

const CORPUS = { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus-service-abc123', purpose: 'corpus-sync', oneTime: false, expiresAt: null };
const RUNNER = { grantId: 'vdg_2', grantedTo: 'did:imajin:warp-runner-xyz789', purpose: null, oneTime: true, expiresAt: null };

describe('N>0 other grantees, rotate re-issues them (#2450)', () => {
  it('shows the count and each grantee, and does not block Rotate', async () => {
    installGranteesFetch([CORPUS, RUNNER], { reissuedOnRotate: true });
    const { onSubmit } = renderDialog();

    await waitFor(() => expect(screen.getByText(/2 active grantees will be re-issued on the new key/)).toBeDefined());
    expect(screen.getByText(/corpus-sync/)).toBeDefined();
    expect(screen.getByText(/operator-initiated/)).toBeDefined();
    expect(screen.queryByLabelText(/Type/)).toBeNull();

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', false);

    fireEvent.click(rotateButton());
    const [input] = onSubmit.mock.calls[0];
    expect(input).toMatchObject({ field: FIELD, value: 'new-secret-value' });
    expect(input).not.toHaveProperty('confirmField');
  });

  it('uses the singular for one grantee', async () => {
    installGranteesFetch([CORPUS], { reissuedOnRotate: true });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/1 active grantee will be re-issued/)).toBeDefined());
  });
});

describe('N>0 other grantees, rotate cannot re-issue them (Tier 1, #2450)', () => {
  it('lists them and keeps Rotate disabled', async () => {
    installGranteesFetch([CORPUS, RUNNER], { reissuedOnRotate: false });
    const { onSubmit } = renderDialog();

    await waitFor(() => expect(screen.getByText(/2 active grantees cannot be re-issued/)).toBeDefined());
    expect(screen.getByText(/corpus-sync/)).toBeDefined();
    expect(screen.getByText(/Revoke them first/)).toBeDefined();

    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', true);
    fireEvent.click(rotateButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('grantee lookup failure (#2450)', () => {
  it('is treated as unknown, not zero: shows the error and blocks Rotate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    const { onSubmit } = renderDialog();

    await waitFor(() => expect(screen.getByText(/Could not check for other active grantees/)).toBeDefined());
    fireEvent.change(valueInput(), { target: { value: 'new-secret-value' } });
    expect(rotateButton()).toHaveProperty('disabled', true);
    fireEvent.click(rotateButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
