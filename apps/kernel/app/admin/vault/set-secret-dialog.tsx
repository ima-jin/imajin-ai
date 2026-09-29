'use client';

import { useEffect, useState } from 'react';
import {
  VAULT_FIELD_NAME_RULE,
  defaultCustodyForField,
  isValidVaultFieldName,
} from '@/src/lib/vault/field-grammar';
import type { KnownVaultFieldApiRow, SetSecretInput, VaultCustodyScheme } from './types';

interface SetSecretDialogProps {
  open: boolean;
  submitting: boolean;
  /** Suggestions for the field input (#2445 defect 4) — fields the kernel is known to read. */
  knownFields: readonly KnownVaultFieldApiRow[];
  /** Pre-fills the field name when opened from a "missing" row's Add action. */
  initialField?: string;
  onClose: () => void;
  onSubmit: (input: SetSecretInput) => Promise<void>;
}

const KNOWN_FIELDS_DATALIST_ID = 'vault-known-fields';

export function SetSecretDialog({
  open,
  submitting,
  knownFields,
  initialField,
  onClose,
  onSubmit,
}: Readonly<SetSecretDialogProps>) {
  const [field, setField] = useState(initialField ?? '');
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const [custodyScheme, setCustodyScheme] = useState<VaultCustodyScheme>(
    () => defaultCustodyForField(initialField ?? '').scheme,
  );

  // Reset the form to the (possibly pre-filled) initial field every time the
  // dialog opens, rather than leaving whatever was typed the last time it
  // was cancelled — including when it is reopened for a DIFFERENT missing
  // field, since this is a single shared dialog instance.
  useEffect(() => {
    if (!open) {
      return;
    }
    const startField = initialField ?? '';
    setField(startField);
    setValue('');
    setHint('');
    setCustodyScheme(defaultCustodyForField(startField).scheme);
  }, [open, initialField]);

  if (!open) {
    return null;
  }

  const trimmedField = field.trim();
  const fieldIsValid = trimmedField.length === 0 || isValidVaultFieldName(trimmedField);
  const custodyDefault = defaultCustodyForField(trimmedField);
  const effectiveCustody = custodyDefault.locked ? custodyDefault.scheme : custodyScheme;
  const canSubmit = trimmedField.length > 0 && isValidVaultFieldName(trimmedField) && value.length > 0;

  function handleFieldChange(next: string): void {
    setField(next);
    // Re-derive the default (and lock) for the field as typed. A field the
    // kernel hard-requires a scheme for always resets to it; anything else
    // resets to node-sealed — a manual custody pick applies to whichever
    // field name is currently in the box, not one edited since.
    setCustodyScheme(defaultCustodyForField(next.trim()).scheme);
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    await onSubmit({
      field: trimmedField,
      value,
      hint: hint.trim(),
      custodyScheme: effectiveCustody,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Set Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Value is transmitted over TLS and sealed server-side. Custody (below) decides who — the node
          alone, or a delegation grant — can read it back.
        </p>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div>
            <label htmlFor="vault-secret-field" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Field</label>
            <input
              id="vault-secret-field"
              required
              list={KNOWN_FIELDS_DATALIST_ID}
              value={field}
              onChange={(event) => handleFieldChange(event.target.value)}
              placeholder="github-org-provisioning"
              className={`w-full rounded-lg border bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 ${
                fieldIsValid
                  ? 'border-gray-300 dark:border-gray-600 focus:ring-orange-500'
                  : 'border-red-400 dark:border-red-600 focus:ring-red-500'
              }`}
            />
            <datalist id={KNOWN_FIELDS_DATALIST_ID}>
              {knownFields.map((known) => (
                <option key={known.field} value={known.field}>{known.description}</option>
              ))}
            </datalist>
            <p className={`mt-1 text-xs ${fieldIsValid ? 'text-gray-400 dark:text-gray-500' : 'text-red-600 dark:text-red-400'}`}>
              {fieldIsValid ? VAULT_FIELD_NAME_RULE : `Not a valid field name — ${VAULT_FIELD_NAME_RULE}`}
            </p>
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
          <fieldset>
            <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Custody</legend>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vault-custody-node-sealed" className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  id="vault-custody-node-sealed"
                  type="radio"
                  name="vault-custody-scheme"
                  value="node-sealed"
                  checked={effectiveCustody === 'node-sealed'}
                  disabled={custodyDefault.locked}
                  onChange={() => setCustodyScheme('node-sealed')}
                />
                node-sealed — readable by this node only
              </label>
              <label htmlFor="vault-custody-delegation-grant" className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  id="vault-custody-delegation-grant"
                  type="radio"
                  name="vault-custody-scheme"
                  value="delegation-grant"
                  checked={effectiveCustody === 'delegation-grant'}
                  disabled={custodyDefault.locked}
                  onChange={() => setCustodyScheme('delegation-grant')}
                />
                delegation-grant — self-granted v2 custody
              </label>
            </div>
            {custodyDefault.locked && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                🔒 required for this field — {custodyDefault.why}
              </p>
            )}
          </fieldset>
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
              disabled={submitting || !canSubmit}
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
