'use client';

import { useState } from 'react';
import type { RotateSecretInput } from './types';
import { describeGrantee, useVaultGrantees } from './use-vault-grantees';

interface RotateSecretDialogProps {
  field: string | null;
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: RotateSecretInput) => Promise<void>;
}

export function RotateSecretDialog({
  field,
  open,
  submitting,
  onClose,
  onSubmit,
}: Readonly<RotateSecretDialogProps>) {
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const {
    loading: loadingGrantees,
    grantees,
    error: granteesError,
    reissuedOnRotate,
  } = useVaultGrantees(field, open);

  if (!open || !field) {
    return null;
  }

  // #2450: rotating re-seals under a new key, so every OTHER active grantee's
  // copy of the wrapped key would stop decrypting. The server re-issues them
  // on rotate (same grantee set, expiry / one-time / purpose carried forward)
  // and refuses outright when it cannot (Tier 1 custody) — this dialog lists
  // who is affected and blocks Rotate in exactly the cases the server would
  // refuse. A grantee-query failure is treated as "unknown", never as zero.
  const hasOtherGrantees = grantees.length > 0;
  const blocked = granteesError !== null || (hasOtherGrantees && !reissuedOnRotate);
  const canSubmit = !submitting && !loadingGrantees && value.trim().length > 0 && !blocked;

  async function handleRotate(): Promise<void> {
    await onSubmit({ field: field ?? '', value, hint: hint.trim() });
    setValue('');
    setHint('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Rotate Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Submit a new value for <span className="font-mono">{field}</span>. Transmitted over TLS, sealed server-side, and a rotation event is published.
        </p>

        {loadingGrantees && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">Checking for other active grantees…</p>
        )}

        {!loadingGrantees && granteesError && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 mb-4">
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              ⚠️ Could not check for other active grantees: {granteesError}
            </p>
            <p className="mt-1 text-xs text-red-800 dark:text-red-300">
              Treated as unknown, not zero — close and reopen this dialog to retry.
            </p>
          </div>
        )}

        {!loadingGrantees && hasOtherGrantees && (
          <div
            className={
              reissuedOnRotate
                ? 'rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4'
                : 'rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 mb-4'
            }
          >
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              ⚠️ {grantees.length} active grantee{grantees.length === 1 ? '' : 's'}{' '}
              {reissuedOnRotate ? 'will be re-issued on the new key' : 'cannot be re-issued — rotate is blocked'}
            </p>
            <ul className="mt-1 list-disc list-inside text-xs text-amber-800 dark:text-amber-300 font-mono">
              {grantees.map((grantee) => (
                <li key={grantee.grantId}>{describeGrantee(grantee)}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              {reissuedOnRotate
                ? 'Each grantee keeps its own purpose, expiry and one-time terms; expired or consumed grants are not renewed. Re-issue is operator-initiated — it happens only because you rotate.'
                : 'This node cannot sign replacement grants (Tier 1 vault custody), so rotating would strand these grantees. Revoke them first.'}
            </p>
          </div>
        )}

        <label htmlFor="rotate-secret-value" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New value</label>
        <input
          id="rotate-secret-value"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <label htmlFor="rotate-secret-hint" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Hint <span className="text-gray-400">(optional)</span>
        </label>
        <input
          id="rotate-secret-hint"
          value={hint}
          onChange={(event) => setHint(event.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleRotate}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Rotating…' : 'Rotate'}
          </button>
        </div>
      </div>
    </div>
  );
}
