'use client';

import { useEffect, useState } from 'react';
import { useVaultGrantees } from './use-vault-grantees';

interface DeleteSecretDialogProps {
  field: string | null;
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (field: string) => Promise<void>;
}

/**
 * Typed-confirmation delete (#2698). Warns with the COUNT of other active
 * grantees (never any value — they are revoked with the field) and requires
 * the operator to type the exact field name, so a mis-click can never
 * tombstone the wrong field. The server enforces the same grantee
 * confirmation itself; this dialog only makes it explicit.
 */
export function DeleteSecretDialog({
  field,
  open,
  submitting,
  onClose,
  onConfirm,
}: Readonly<DeleteSecretDialogProps>) {
  const [confirmText, setConfirmText] = useState('');
  const { loading: loadingGrantees, grantees, error: granteesError } = useVaultGrantees(field, open);

  useEffect(() => {
    if (!open) {
      setConfirmText('');
    }
  }, [open]);

  if (!open || !field) {
    return null;
  }

  const granteeCount = grantees.length;
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
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Delete Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Deletes <span className="font-mono text-gray-900 dark:text-white">{field}</span> and revokes every
          active grant on it. Any reader that relies on this field fails immediately; the signed history stays
          intact.
        </p>
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 mb-4">
          <p className="text-sm text-red-800 dark:text-red-300">
            ⚠️ This cannot be undone. Type the field name below to confirm.
          </p>
        </div>

        {loadingGrantees && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">Checking for active grantees…</p>
        )}

        {!loadingGrantees && granteesError && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 mb-4">
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              ⚠️ Could not check for active grantees: {granteesError}
            </p>
            <p className="mt-1 text-xs text-red-800 dark:text-red-300">
              Treated as unknown, not zero — the server still asks for confirmation if any exist.
            </p>
          </div>
        )}

        {!loadingGrantees && granteeCount > 0 && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              ⚠️ {granteeCount} active grantee{granteeCount === 1 ? '' : 's'} will lose access
            </p>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              Their grants are revoked together with the delete, in one transaction. Deleting does not
              re-issue or notify them.
            </p>
          </div>
        )}

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
            disabled={submitting || loadingGrantees || !matches}
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
