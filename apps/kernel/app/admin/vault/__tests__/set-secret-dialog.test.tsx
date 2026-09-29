// @vitest-environment jsdom
/**
 * SetSecretDialog (#2445).
 *
 * The three things worth pinning: the field name is submitted EXACTLY as
 * typed (the old `toUpperCase()` defect, live on prod 2026-09-29), an
 * invalid name blocks submission with the grammar rule shown inline, and
 * the custody selector defaults to — and locks — delegation-grant for a
 * field the kernel hard-requires it for.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SetSecretDialog } from '../set-secret-dialog';
import { VAULT_FIELD_NAME_RULE } from '@/src/lib/vault/field-grammar';
import type { KnownVaultFieldApiRow } from '../types';

const KNOWN_FIELDS: KnownVaultFieldApiRow[] = [
  {
    field: 'github-org-provisioning',
    description: 'Org-scoped GitHub App installation credential.',
    requiredCustody: 'delegation-grant',
    why: 'org-provisioning.ts reads this only through the v2 delegation-grant path.',
  },
];

function renderDialog(overrides: Partial<Parameters<typeof SetSecretDialog>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <SetSecretDialog
      open
      submitting={false}
      knownFields={KNOWN_FIELDS}
      onClose={onClose}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit, onClose };
}

function fieldInput(): HTMLInputElement {
  return screen.getByLabelText('Field') as HTMLInputElement;
}

function valueInput(): HTMLInputElement {
  return screen.getByLabelText('Value') as HTMLInputElement;
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /Save Secret/ });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('field name — no case transform', () => {
  it('submits a namespaced, real-DID-shaped connector field exactly as typed', async () => {
    const { onSubmit } = renderDialog();
    const field = 'warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT';

    fireEvent.change(fieldInput(), { target: { value: field } });
    fireEvent.change(valueInput(), { target: { value: 'secret-value' } });
    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ field }));
  });

  it('submits a legacy ENV_STYLE field unchanged', async () => {
    const { onSubmit } = renderDialog();

    fireEvent.change(fieldInput(), { target: { value: 'GH_TOKEN' } });
    fireEvent.change(valueInput(), { target: { value: 'ghp_xyz' } });
    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ field: 'GH_TOKEN' }));
  });

  it('shows the grammar rule inline', () => {
    const { container } = render(
      <SetSecretDialog open submitting={false} knownFields={KNOWN_FIELDS} onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(container.textContent).toContain('lowercase-hyphen');
    expect(container.textContent).toContain(VAULT_FIELD_NAME_RULE);
  });

  it('blocks submission on an invalid (mixed-case) field name', () => {
    const { onSubmit } = renderDialog();

    fireEvent.change(fieldInput(), { target: { value: 'GITHUB-org-Provisioning' } });
    fireEvent.change(valueInput(), { target: { value: 'x' } });

    expect(saveButton()).toHaveProperty('disabled', true);
    fireEvent.click(saveButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pre-fills the field from initialField (missing-row Add flow)', () => {
    renderDialog({ initialField: 'github-org-provisioning' });
    expect(fieldInput().value).toBe('github-org-provisioning');
  });
});

describe('internal-secret:* refusal (#2450 DECISION a)', () => {
  it('blocks submission and explains that Rotate is the only path', () => {
    const { onSubmit } = renderDialog();

    fireEvent.change(fieldInput(), { target: { value: 'internal-secret:kernel.foreign-principal-pepper' } });
    fireEvent.change(valueInput(), { target: { value: 'x' } });

    expect(saveButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/use Rotate on the existing row, not Set/)).toBeDefined();
    fireEvent.click(saveButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('custody selector', () => {
  it('defaults to node-sealed, unlocked, for an unrecognized field', () => {
    renderDialog();
    fireEvent.change(fieldInput(), { target: { value: 'GH_TOKEN' } });

    const nodeSealed = screen.getByLabelText(/node-sealed/) as HTMLInputElement;
    const delegationGrant = screen.getByLabelText(/delegation-grant —/) as HTMLInputElement;
    expect(nodeSealed.checked).toBe(true);
    expect(nodeSealed.disabled).toBe(false);
    expect(delegationGrant.disabled).toBe(false);
  });

  it('lets the operator choose delegation-grant for an unlocked field', () => {
    renderDialog();
    fireEvent.change(fieldInput(), { target: { value: 'GH_TOKEN' } });
    fireEvent.click(screen.getByLabelText(/delegation-grant —/));
    expect((screen.getByLabelText(/delegation-grant —/) as HTMLInputElement).checked).toBe(true);
  });

  it('defaults to and locks delegation-grant for github-org-provisioning, with a one-line why', () => {
    renderDialog({ initialField: 'github-org-provisioning' });

    const nodeSealed = screen.getByLabelText(/node-sealed/) as HTMLInputElement;
    const delegationGrant = screen.getByLabelText(/delegation-grant —/) as HTMLInputElement;
    expect(delegationGrant.checked).toBe(true);
    expect(nodeSealed.disabled).toBe(true);
    expect(delegationGrant.disabled).toBe(true);
    expect(screen.getByText(/required for this field/)).toBeDefined();
  });

  it('submits the locked custody scheme even though the selector is disabled', () => {
    const { onSubmit } = renderDialog({ initialField: 'github-org-provisioning' });
    fireEvent.change(valueInput(), { target: { value: 'x' } });
    fireEvent.click(saveButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ custodyScheme: 'delegation-grant' }));
  });
});

describe('suggestions', () => {
  it('lists known fields as datalist options', () => {
    renderDialog();
    const option = document.querySelector('option[value="github-org-provisioning"]');
    expect(option).not.toBeNull();
  });
});
