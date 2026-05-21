'use client';

import { formatDistanceToNow } from 'date-fns';
import type { VaultHistoryEntry } from './types';

interface HistoryDialogProps {
  field: string | null;
  entries: VaultHistoryEntry[];
  open: boolean;
  onClose: () => void;
}

function actionLabel(action: VaultHistoryEntry['action']): string {
  return action === 'rotate' ? 'Rotated' : 'Set';
}

export function HistoryDialog({ field, entries, open, onClose }: HistoryDialogProps) {
  if (!open || !field) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">History</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 font-mono">{field}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Close
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No history entries yet.</p>
        ) : (
          <div className="rounded-lg border border-gray-100 dark:border-gray-700 overflow-hidden">
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {entries.map((entry) => (
                <div key={`${entry.cid}:${entry.updatedAt}`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {actionLabel(entry.action)}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formatDistanceToNow(new Date(entry.updatedAt), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                    {entry.cid}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">by {entry.setBy}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
