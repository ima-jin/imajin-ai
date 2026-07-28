'use client';

interface RevokeGrantDialogProps {
  field: string | null;
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (field: string) => Promise<void>;
}

export function RevokeGrantDialog({
  field,
  open,
  submitting,
  onClose,
  onConfirm,
}: Readonly<RevokeGrantDialogProps>) {
  if (!open || !field) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Revoke Delegation Grant</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Revoke the active delegation grant for{' '}
          <span className="font-mono text-gray-900 dark:text-white">{field}</span>?
        </p>
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            ⚠️ Field becomes unreadable until re-sealed. Any active process that relies on this
            field will fail immediately.
          </p>
        </div>
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
            disabled={submitting}
            onClick={() => void onConfirm(field)}
            className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Revoking…' : 'Revoke Grant'}
          </button>
        </div>
      </div>
    </div>
  );
}
