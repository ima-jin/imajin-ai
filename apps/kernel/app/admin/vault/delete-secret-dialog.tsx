'use client';

import { useEffect, useState } from 'react';

interface DeleteSecretDialogProps {
  field: string | null;
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (field: string) => Promise<void>;
}

/**
 * Typed-confirmation delete (#2445 defect 5) — retires a mis-named or dead
 * row. Requires the operator to type the exact field name, so a mis-click
 * can't tombstone the wrong field.
 */
export function DeleteSecretDialog({
  field,
  open,
  submitting,
  onClose,
  onConfirm,
}: Readonly<DeleteSecretDialogProps>) {
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    if (!open) {
      setConfirmText('');
    }
  }, [open]);

  if (!open || !field) {
    return null;
  }

  const matches = confirmText === field;

  async function handleConfirm(): Promise<void> {
    if (!field || !matches) {
      return;
    }
    await onConfirm(field);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Delete Vault Entry</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Tombstones <span className="font-mono text-gray-900 dark:text-white">{field}</span>. Any reader that
          relies on this field fails immediately; the signed history stays intact.
        </p>
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 mb-4">
          <p className="text-sm text-red-800 dark:text-red-300">
            ⚠️ Only for a mis-named or dead row. Type the field name below to confirm.
          </p>
        </div>
        <label htmlFor="delete-secret-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Type <span className="font-mono">{field}</span> to confirm
        </label>
        <input
          id="delete-secret-confirm"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !matches}
            onClick={() => void handleConfirm()}
            className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
