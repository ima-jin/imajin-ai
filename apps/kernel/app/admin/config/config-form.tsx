'use client';

import { useState } from 'react';

interface ConfigFormProps {
  registrationMode: string;
  maxIdentities: number;
  maxStoragePerDidMb: number;
}

export function ConfigForm({ registrationMode, maxIdentities, maxStoragePerDidMb }: ConfigFormProps) {
  const [regMode, setRegMode] = useState(registrationMode);
  const [maxIds, setMaxIds] = useState(String(maxIdentities));
  const [maxStorage, setMaxStorage] = useState(String(maxStoragePerDidMb));
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save(key: string, value: unknown) {
    setSaving(key);
    setSaved(null);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) throw new Error('Failed');
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
    } catch {
      // no-op
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Registration Mode */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Registration Mode</h2>
        <div className="flex items-center gap-4">
          <select
            value={regMode}
            onChange={(e) => setRegMode(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="open">Open</option>
            <option value="invite_only">Invite Only</option>
            <option value="closed">Closed</option>
          </select>
          <button
            onClick={() => save('registration_mode', regMode)}
            disabled={saving === 'registration_mode'}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            {saving === 'registration_mode' ? 'Saving…' : saved === 'registration_mode' ? 'Saved!' : 'Save'}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Controls who can register new identities on this node.
        </p>
      </div>

      {/* Resource Limits */}
      <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Resource Limits</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Max Identities (0 = unlimited)
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                value={maxIds}
                onChange={(e) => setMaxIds(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 w-36"
              />
              <button
                onClick={() => save('max_identities', Number(maxIds))}
                disabled={saving === 'max_identities'}
                className="rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
              >
                {saving === 'max_identities' ? 'Saving…' : saved === 'max_identities' ? 'Saved!' : 'Save'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Max Storage per DID (MB, 0 = unlimited)
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                value={maxStorage}
                onChange={(e) => setMaxStorage(e.target.value)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 w-36"
              />
              <button
                onClick={() => save('max_storage_per_did_mb', Number(maxStorage))}
                disabled={saving === 'max_storage_per_did_mb'}
                className="rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
              >
                {saving === 'max_storage_per_did_mb' ? 'Saving…' : saved === 'max_storage_per_did_mb' ? 'Saved!' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
