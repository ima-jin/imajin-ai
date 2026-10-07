// @vitest-environment jsdom
/**
 * SetSecretDialog (#2699) — the dialog validates the field name with the shared
 * vault field grammar instead of its own regex, so the browser and the
 * `/api/vault/set` route can never disagree about what a field name is.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SetSecretDialog, defaultCustody } from '../set-secret-dialog';
import { VAULT_FIELD_NAME_RULE } from '@/src/lib/vault/field-grammar';

afterEach(cleanup);

function renderDialog() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<SetSecretDialog open submitting={false} onClose={vi.fn()} onSubmit={onSubmit} />);
  return { onSubmit };
}

function typeField(field: string) {
  fireEvent.change(screen.getByLabelText('Field'), { target: { value: field } });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save Secret' }) as HTMLButtonElement;
}

describe('defaultCustody', () => {
  it('is node-sealed for a bare ENV_STYLE name', () => {
    expect(defaultCustody('GH_TOKEN')).toBe('node-sealed');
  });

  it('is delegation-grant for namespaced and lowercase-hyphen fields', () => {
    expect(defaultCustody('github-org-provisioning')).toBe('delegation-grant');
    expect(defaultCustody('warp-agent-key:did:imajin:abc')).toBe('delegation-grant');
  });
});

describe('SetSecretDialog field validation', () => {
  it.each(['a::b', 'internal-secret:x:', 'gh token', 'a/b'])('flags %j with the grammar rule and disables Save', (field) => {
    renderDialog();
    typeField(field);
    expect(screen.getByRole('alert').textContent).toContain(VAULT_FIELD_NAME_RULE);
    expect(screen.getByLabelText('Field').getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
  });

  it.each(['GH_TOKEN', 'github-org-provisioning', 'warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT'])(
    'accepts %j and submits it exactly as typed (case preserved)',
    async (field) => {
      const { onSubmit } = renderDialog();
      typeField(`  ${field}  `);
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'secret' } });
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(saveButton());
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0]).toMatchObject({ field, value: 'secret' });
    },
  );

  it('still blocks internal-secret:* fields, which parse as valid but are kernel-owned', () => {
    renderDialog();
    typeField('internal-secret:kernel.pepper');
    expect(screen.getByRole('alert').textContent).toContain('internal-secret');
    expect(saveButton().disabled).toBe(true);
  });
});
