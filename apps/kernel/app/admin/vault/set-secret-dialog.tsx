'use client';

import { useState } from 'react';
import {
  isEnvStyleFieldName,
  isInternalSecretField,
  isValidVaultFieldName,
  VAULT_FIELD_NAME_RULE,
} from '@/src/lib/vault/field-grammar';
import type { SetSecretInput, VaultCustodyScheme } from './types';

/** ENV_STYLE names are plain node-sealed secrets; every namespaced field the kernel reads is a delegation grant. */
export function defaultCustody(field: string): VaultCustodyScheme {
  return isEnvStyleFieldName(field) ? 'node-sealed' : 'delegation-grant';
}

interface SetSecretDialogProps {
  open: boolean;
  /** Fields already in the vault. Set never overwrites one — use Rotate (#2452). */
  existingFields?: readonly string[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: SetSecretInput) => Promise<void>;
}

export function SetSecretDialog({ open, existingFields = [], submitting, onClose, onSubmit }: Readonly<SetSecretDialogProps>) {
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const [custodyChoice, setCustodyChoice] = useState<VaultCustodyScheme | null>(null);

  if (!open) {
    return null;
  }

  const trimmedField = field.trim();
  const fieldInvalid = trimmedField.length > 0 && !isValidVaultFieldName(trimmedField);
  const custodyScheme = custodyChoice ?? defaultCustody(trimmedField);
  // #2452 — the server refuses both (409); the dialog says so up front instead
  // of offering a Save that re-seals over grantees or touches the kernel's own secrets.
  const fieldInternal = isInternalSecretField(trimmedField);
  const fieldExists = !fieldInternal && existingFields.includes(trimmedField);
  const fieldBlocked = fieldInternal || fieldExists;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!isValidVaultFieldName(trimmedField) || fieldBlocked) return;
    await onSubmit({
      field: trimmedField,
      value,
      hint: hint.trim(),
      custodyScheme,
    });
    setField('');
    setValue('');
    setHint('');
    setCustodyChoice(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Set Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Value is transmitted over TLS and sealed server-side with the node key. Encrypted at rest; choose the custody below.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="vault-secret-field" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Field</label>
            <input
              id="vault-secret-field"
              required
              value={field}
              onChange={(event) => setField(event.target.value)}
              placeholder="github-org-provisioning"
              aria-invalid={fieldInvalid}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            {fieldInternal && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                internal-secret:* fields are the kernel&apos;s own secrets and cannot be set here.
              </p>
            )}
            {fieldExists && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                This field already exists. Setting it again would re-seal it under a new key and strand any
                grantees — close this dialog and use Rotate on its row instead.
              </p>
            )}
            {fieldInvalid && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {VAULT_FIELD_NAME_RULE}. Case is preserved.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="vault-secret-custody" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Custody</label>
            <select
              id="vault-secret-custody"
              value={custodyScheme}
              onChange={(event) => setCustodyChoice(event.target.value as VaultCustodyScheme)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="node-sealed">node-sealed</option>
              <option value="delegation-grant">delegation-grant</option>
            </select>
          </div>
          <div>
            <label htmlFor="vault-secret-value" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Value</label>
            <input
              id="vault-secret-value"
              required
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div>
            <label htmlFor="vault-secret-hint" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Hint <span className="text-gray-400">(optional)</span>
            </label>
            <input
              id="vault-secret-hint"
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="ghp_"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || fieldInvalid || fieldBlocked}
              className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save Secret'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
