'use client';

import { useEffect, useState } from 'react';
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
  const [confirmText, setConfirmText] = useState('');
  const { loading: loadingGrantees, grantees } = useVaultGrantees(field, open);

  useEffect(() => {
    if (!open) {
      setValue('');
      setHint('');
      setConfirmText('');
    }
  }, [open]);

  if (!open || !field) {
    return null;
  }

  // #2450 step 1: rotating re-seals under a new key and re-grants only the
  // node's own self-grant — every OTHER active grantee's copy of the wrapped
  // key still points at the material being replaced, so it silently stops
  // decrypting. Require a typed confirmation naming the blast radius before
  // that can happen; re-issuing those grantees generically is #2450 step 2,
  // not yet implemented, so the honest thing here is to warn, not to claim
  // it's handled.
  const hasOtherGrantees = grantees.length > 0;
  const confirmed = !hasOtherGrantees || confirmText === field;
  const canSubmit = !submitting && value.trim().length > 0 && confirmed;

  async function handleRotate(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    await onSubmit({ field: field ?? '', value, hint: hint.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Rotate Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Submit a new value for <span className="font-mono">{field}</span>. Transmitted over TLS, sealed server-side, and a rotation event is published.
        </p>

        {!loadingGrantees && hasOtherGrantees && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              ⚠️ {grantees.length} active grantee{grantees.length === 1 ? '' : 's'} will need re-issue
            </p>
            <ul className="mt-1 list-disc list-inside text-xs text-amber-800 dark:text-amber-300 font-mono">
              {grantees.map((grantee) => (
                <li key={grantee.grantedTo}>{describeGrantee(grantee)}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              Rotating re-seals this field under a new key. These grantees&apos; existing copies will
              stop decrypting unless they are re-issued a grant on the new key — this rotate path does
              not do that automatically yet.
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

        {hasOtherGrantees && (
          <>
            <label htmlFor="rotate-secret-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Type <span className="font-mono">{field}</span> to confirm rotating past these grantees
            </label>
            <input
              id="rotate-secret-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </>
        )}

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
            onClick={() => void handleRotate()}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Rotating…' : 'Rotate'}
          </button>
        </div>
      </div>
    </div>
  );
}
