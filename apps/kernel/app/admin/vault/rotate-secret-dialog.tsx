'use client';

import { useState } from 'react';
import type { RotateSecretInput } from './types';

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

  if (!open || !field) {
    return null;
  }

  async function handleRotate(): Promise<void> {
    await onSubmit({ field, value, hint: hint.trim() });
    setValue('');
    setHint('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Rotate Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Submit a new encrypted value for <span className="font-mono">{field}</span> and publish a rotation event.
        </p>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New value</label>
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Hint <span className="text-gray-400">(optional)</span>
        </label>
        <input
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
            disabled={submitting || value.trim().length === 0}
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
