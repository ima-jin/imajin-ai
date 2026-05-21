'use client';

import { useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { HistoryDialog } from './history-dialog';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { SetSecretDialog } from './set-secret-dialog';
import type {
  RotateSecretInput,
  SetSecretInput,
  VaultHistoryEntry,
  VaultSecretRow,
} from './types';

interface VaultPanelProps {
  initialSecrets: VaultSecretRow[];
  initialHistory: Record<string, VaultHistoryEntry[]>;
}

function createCid(field: string): string {
  const cleanField = field.replace(/[^A-Z0-9]/gi, '').toLowerCase().slice(0, 8);
  const random = Math.random().toString(36).slice(2, 12);
  return `bafy${cleanField}${random}`;
}

function createHint(value: string, hint: string): string {
  const source = hint.trim() || value.trim();
  if (!source) return '••••';
  return `${source.slice(0, 4)}...`;
}

function statusBadge(status: VaultSecretRow['status']): string {
  if (status === 'confirmed') {
    return '🟢 confirmed';
  }
  return '🟡 pending';
}

export function VaultPanel({ initialSecrets, initialHistory }: VaultPanelProps) {
  const [secrets, setSecrets] = useState<VaultSecretRow[]>(initialSecrets);
  const [historyByField, setHistoryByField] = useState<Record<string, VaultHistoryEntry[]>>(initialHistory);
  const [setOpen, setSetOpen] = useState(false);
  const [rotateField, setRotateField] = useState<string | null>(null);
  const [historyField, setHistoryField] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedSecrets = useMemo(
    () => [...secrets].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [secrets]
  );

  async function handleSetSecret(input: SetSecretInput): Promise<void> {
    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      const nextCid = createCid(input.field);
      const nextRow: VaultSecretRow = {
        field: input.field,
        hint: createHint(input.value, input.hint),
        cid: nextCid,
        setBy: input.setBy,
        updatedAt: now,
        status: 'pending',
      };
      setSecrets((current) => {
        const withoutField = current.filter((row) => row.field !== input.field);
        return [nextRow, ...withoutField];
      });
      setHistoryByField((current) => ({
        ...current,
        [input.field]: [
          {
            field: input.field,
            cid: nextCid,
            setBy: input.setBy,
            updatedAt: now,
            action: 'set',
          },
          ...(current[input.field] ?? []),
        ],
      }));
      setSetOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRotateSecret(input: RotateSecretInput): Promise<void> {
    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      const nextCid = createCid(input.field);
      setSecrets((current) =>
        current.map((row) =>
          row.field === input.field
            ? {
                ...row,
                cid: nextCid,
                setBy: input.setBy,
                updatedAt: now,
                status: 'pending',
              }
            : row
        )
      );
      setHistoryByField((current) => ({
        ...current,
        [input.field]: [
          {
            field: input.field,
            cid: nextCid,
            setBy: input.setBy,
            updatedAt: now,
            action: 'rotate',
          },
          ...(current[input.field] ?? []),
        ],
      }));
      setRotateField(null);
    } finally {
      setSubmitting(false);
    }
  }

  function markConfirmed(field: string): void {
    setSecrets((current) =>
      current.map((row) =>
        row.field === field
          ? {
              ...row,
              status: 'confirmed',
            }
          : row
      )
    );
  }

  const historyEntries = historyField ? historyByField[historyField] ?? [] : [];

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 p-4">
        <p className="text-sm text-orange-800 dark:text-orange-300">
          Vault UI scaffolding is active. Final API wiring, browser encryption, and live status confirmations will attach to #1006 backend endpoints/events.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Secrets</h2>
        <button
          type="button"
          onClick={() => setSetOpen(true)}
          className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium"
        >
          + Set Secret
        </button>
      </div>

      <div className="hidden md:block rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Field</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Hint</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">CID</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Set by</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Updated</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedSecrets.map((secret) => (
                <tr key={secret.field} className="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-white">{secret.field}</td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{secret.hint}</td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-[180px]">{secret.cid}</td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{secret.setBy}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700 dark:text-gray-300">{statusBadge(secret.status)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setRotateField(secret.field)}
                        className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryField(secret.field)}
                        className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        History
                      </button>
                      {secret.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => markConfirmed(secret.field)}
                          className="rounded-lg border border-green-300 dark:border-green-700 px-2 py-1 text-xs text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20"
                        >
                          Mark confirmed
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="md:hidden space-y-3">
        {sortedSecrets.map((secret) => (
          <div key={secret.field} className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-gray-900 dark:text-white">{secret.field}</p>
                <p className="text-sm text-gray-700 dark:text-gray-300">{secret.hint}</p>
              </div>
              <span className="text-xs text-gray-700 dark:text-gray-300">{statusBadge(secret.status)}</span>
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono break-all">{secret.cid}</p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {secret.setBy} · {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setRotateField(secret.field)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Rotate
              </button>
              <button
                type="button"
                onClick={() => setHistoryField(secret.field)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                History
              </button>
              {secret.status === 'pending' && (
                <button
                  type="button"
                  onClick={() => markConfirmed(secret.field)}
                  className="rounded-lg border border-green-300 dark:border-green-700 px-2 py-1 text-xs text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20"
                >
                  Mark confirmed
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <SetSecretDialog
        open={setOpen}
        submitting={submitting}
        onClose={() => setSetOpen(false)}
        onSubmit={handleSetSecret}
      />
      <RotateSecretDialog
        field={rotateField}
        open={rotateField !== null}
        submitting={submitting}
        onClose={() => setRotateField(null)}
        onSubmit={handleRotateSecret}
      />
      <HistoryDialog
        field={historyField}
        entries={historyEntries}
        open={historyField !== null}
        onClose={() => setHistoryField(null)}
      />
    </div>
  );
}
