'use client';

import { useState } from 'react';
import type { SetSecretInput } from './types';

interface SetSecretDialogProps {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: SetSecretInput) => Promise<void>;
}

export function SetSecretDialog({ open, submitting, onClose, onSubmit }: Readonly<SetSecretDialogProps>) {
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');

  if (!open) {
    return null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onSubmit({
      field: field.trim().toUpperCase(),
      value,
      hint: hint.trim(),
    });
    setField('');
    setValue('');
    setHint('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Set Secret</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Value is encrypted in the browser and only encrypted payloads are sent to the vault API.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="vault-secret-field" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Field</label>
            <input
              id="vault-secret-field"
              required
              value={field}
              onChange={(event) => setField(event.target.value)}
              placeholder="GH_TOKEN"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
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
              disabled={submitting}
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
