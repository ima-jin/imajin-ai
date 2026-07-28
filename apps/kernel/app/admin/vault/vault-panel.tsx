'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { HistoryDialog } from './history-dialog';
import { RevokeGrantDialog } from './revoke-grant-dialog';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { SetSecretDialog } from './set-secret-dialog';
import type {
  AdminEventsApiResponse,
  RotateSecretInput,
  SetSecretInput,
  UpgradeCustodyApiResponse,
  VaultCustodyScheme,
  VaultHistoryApiResponse,
  VaultHistoryEntry,
  VaultListApiRow,
  VaultSecretRow,
  VaultWriteApiResponse,
} from './types';

function createHint(value: string, hint: string): string {
  const source = hint.trim() || value.trim();
  if (!source) return '••••';
  return `${source.slice(0, 4)}...`;
}

function statusBadge(status: VaultSecretRow['status']): string {
  return status === 'confirmed' ? '🟢 confirmed' : '🟡 pending';
}

function CustodyCell({ row }: { row: VaultSecretRow }) {
  const isDelegation = row.custodyScheme === 'delegation-grant';
  const isExpired = row.expiresAt ? new Date(row.expiresAt) < new Date() : false;
  const hasActiveGrant = isDelegation && row.grantStatus === 'active' && !isExpired;
  const isGrantRevoked = isDelegation && (row.grantStatus === 'none' || (row.grantStatus === 'active' && isExpired));

  if (!isDelegation) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
        node-sealed
      </span>
    );
  }

  return (
    <div className="space-y-0.5">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        hasActiveGrant
          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
      }`}>
        {hasActiveGrant ? 'delegation-grant' : isGrantRevoked ? 'grant revoked' : 'delegation-grant'}
      </span>
      {row.grantedTo && (
        <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
          {row.grantedTo.length > 20 ? `${row.grantedTo.slice(0, 14)}…${row.grantedTo.slice(-6)}` : row.grantedTo}
        </p>
      )}
      {row.expiresAt && (
        <p className={`text-xs ${
          isExpired ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
        }`}>
          {isExpired
            ? `expired ${formatDistanceToNow(new Date(row.expiresAt), { addSuffix: true })}`
            : `expires ${formatDistanceToNow(new Date(row.expiresAt), { addSuffix: true })}`}
        </p>
      )}
    </div>
  );
}

function toDisplaySender(senderDid: string): string {
  if (senderDid.length <= 18) return senderDid;
  return `${senderDid.slice(0, 12)}…${senderDid.slice(-6)}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string; code?: string };
    if (data.code) {
      return data.error ? `${data.error} (${data.code})` : data.code;
    }
    return data.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function fetchVaultEvents(): Promise<Set<string>> {
  const response = await fetch('/api/admin/events?service=vault&limit=200', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const data = (await response.json()) as AdminEventsApiResponse;
  const cids = new Set<string>();
  data.rows.forEach((row) => {
    const payloadCid = row.payload && typeof row.payload.cid === 'string' ? row.payload.cid : null;
    if ((row.action === 'vault.secret.updated' || row.action === 'vault.secret.rotated') && payloadCid) {
      cids.add(payloadCid);
    }
  });
  return cids;
}

async function fetchVaultList(): Promise<VaultSecretRow[]> {
  const response = await fetch('/api/vault/list', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const rows = (await response.json()) as VaultListApiRow[];
  return rows.map((row) => ({
    field: row.field,
    hint: row.hint || '••••',
    cid: row.cid,
    setBy: row.senderDid,
    updatedAt: row.timestamp,
    status: 'pending',
    custodyScheme: row.custodyScheme ?? 'node-sealed',
    grantedTo: row.grantedTo,
    expiresAt: row.expiresAt,
    grantStatus: row.grantStatus,
  }));
}

async function fetchHistory(field: string): Promise<VaultHistoryEntry[]> {
  const response = await fetch(`/api/vault/history/${encodeURIComponent(field)}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const data = (await response.json()) as VaultHistoryApiResponse;
  return data.chain.map((entry) => ({
    field: data.field,
    cid: entry.cid,
    setBy: entry.senderDid,
    updatedAt: entry.timestamp,
    action: entry.previousCid === null ? 'set' : 'rotate',
  }));
}

export function VaultPanel() {
  const [secrets, setSecrets] = useState<VaultSecretRow[]>([]);
  const [historyByField, setHistoryByField] = useState<Record<string, VaultHistoryEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setOpen, setSetOpen] = useState(false);
  const [rotateField, setRotateField] = useState<string | null>(null);
  const [historyField, setHistoryField] = useState<string | null>(null);
  const [revokeField, setRevokeField] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  const sortedSecrets = useMemo(
    () => [...secrets].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [secrets]
  );

  const refreshStatuses = useCallback(async (baseRows?: VaultSecretRow[]) => {
    const confirmedCids = await fetchVaultEvents();
    setSecrets((current) => {
      const source = baseRows ?? current;
      return source.map((row) => ({
        ...row,
        status: confirmedCids.has(row.cid) ? 'confirmed' : 'pending',
      }));
    });
  }, []);

  const refreshSecrets = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchVaultList();
      setSecrets(rows);
      setError(null);
      await refreshStatuses(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vault secrets');
    } finally {
      setLoading(false);
    }
  }, [refreshStatuses]);

  useEffect(() => {
    void refreshSecrets();
  }, [refreshSecrets]);

  useEffect(() => {
    if (secrets.length === 0) return undefined;
    const intervalId = globalThis.setInterval(() => {
      void refreshStatuses();
    }, 8000);
    return () => globalThis.clearInterval(intervalId);
  }, [refreshStatuses, secrets.length]);

  useEffect(() => {
    if (!historyField || historyByField[historyField]) return;

    setHistoryLoading(true);
    void fetchHistory(historyField)
      .then((entries) => {
        setHistoryByField((current) => ({
          ...current,
          [historyField]: entries,
        }));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : `Failed to load history for ${historyField}`);
      })
      .finally(() => setHistoryLoading(false));
  }, [historyByField, historyField]);

  async function handleUpgradeCustody(field: string): Promise<void> {
    setUpgrading(field);
    try {
      const response = await fetch('/api/vault/upgrade-custody', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const result = (await response.json()) as UpgradeCustodyApiResponse;
      setSecrets((current) =>
        current.map((row) =>
          row.field === field
            ? {
                ...row,
                cid: result.cid,
                custodyScheme: 'delegation-grant' as VaultCustodyScheme,
                grantedTo: result.grantedTo,
                grantStatus: 'active',
                expiresAt: null,
              }
            : row,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to upgrade custody for ${field}`);
    } finally {
      setUpgrading(null);
    }
  }

  async function handleRevokeGrant(field: string): Promise<void> {
    setSubmitting(true);
    try {
      const response = await fetch('/api/vault/delegation/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setSecrets((current) =>
        current.map((row) =>
          row.field === field
            ? { ...row, grantStatus: 'none', grantedTo: null }
            : row,
        ),
      );
      setRevokeField(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to revoke grant for ${field}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetSecret(input: SetSecretInput): Promise<void> {
    setSubmitting(true);
    try {
      const response = await fetch('/api/vault/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: input.field, value: input.value }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as VaultWriteApiResponse;
      const nextRow: VaultSecretRow = {
        field: input.field,
        hint: createHint(input.value, input.hint),
        cid: result.cid,
        setBy: result.senderDid,
        updatedAt: result.timestamp,
        status: result.status,
        custodyScheme: result.custodyScheme ?? 'node-sealed',
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
            cid: result.cid,
            setBy: result.senderDid,
            updatedAt: result.timestamp,
            action: 'set',
          },
          ...(current[input.field] ?? []),
        ],
      }));
      setError(null);
      setSetOpen(false);
      await refreshStatuses();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRotateSecret(input: RotateSecretInput): Promise<void> {
    setSubmitting(true);
    try {
      const response = await fetch('/api/vault/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: input.field, value: input.value }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as VaultWriteApiResponse;
      setSecrets((current) =>
        current.map((row) =>
          row.field === input.field
            ? {
                ...row,
                cid: result.cid,
                hint: createHint(input.value, input.hint),
                setBy: result.senderDid,
                updatedAt: result.timestamp,
                status: result.status,
                // custodyScheme stays the same after a rotate (v1 rotates v1, v2 stays v2)
              }
            : row
        )
      );
      setHistoryByField((current) => ({
        ...current,
        [input.field]: [
          {
            field: input.field,
            cid: result.cid,
            setBy: result.senderDid,
            updatedAt: result.timestamp,
            action: 'rotate',
          },
          ...(current[input.field] ?? []),
        ],
      }));
      setError(null);
      setRotateField(null);
      await refreshStatuses();
    } finally {
      setSubmitting(false);
    }
  }

  const historyEntries = historyField ? historyByField[historyField] ?? [] : [];

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4">
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Secrets</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshSecrets()}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSetOpen(true)}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-sm font-medium"
          >
            + Set Secret
          </button>
        </div>
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Custody</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-5 text-sm text-gray-500 dark:text-gray-400">
                    Loading vault entries…
                  </td>
                </tr>
              )}
              {!loading && sortedSecrets.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-5 text-sm text-gray-500 dark:text-gray-400">
                    No secrets found yet.
                  </td>
                </tr>
              )}
              {sortedSecrets.map((secret) => {
                const isDelegation = secret.custodyScheme === 'delegation-grant';
                const isExpired = secret.expiresAt ? new Date(secret.expiresAt) < new Date() : false;
                const hasActiveGrant = isDelegation && secret.grantStatus === 'active' && !isExpired;
                const isUpgrading = upgrading === secret.field;
                return (
                  <tr key={secret.field} className="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-white">{secret.field}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{secret.hint}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-[180px]">{secret.cid}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{toDisplaySender(secret.setBy)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700 dark:text-gray-300">{statusBadge(secret.status)}</td>
                    <td className="px-4 py-3">
                      <CustodyCell row={secret} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
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
                        {!isDelegation && (
                          <button
                            type="button"
                            disabled={isUpgrading}
                            onClick={() => void handleUpgradeCustody(secret.field)}
                            className="rounded-lg border border-blue-300 dark:border-blue-700 px-2 py-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
                          >
                            {isUpgrading ? 'Upgrading…' : 'Upgrade'}
                          </button>
                        )}
                        {hasActiveGrant && (
                          <button
                            type="button"
                            onClick={() => setRevokeField(secret.field)}
                            className="rounded-lg border border-red-300 dark:border-red-700 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            Revoke grant
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="md:hidden space-y-3">
        {sortedSecrets.map((secret) => {
          const isDelegation = secret.custodyScheme === 'delegation-grant';
          const isExpired = secret.expiresAt ? new Date(secret.expiresAt) < new Date() : false;
          const hasActiveGrant = isDelegation && secret.grantStatus === 'active' && !isExpired;
          const isUpgrading = upgrading === secret.field;
          return (
            <div key={secret.field} className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-gray-900 dark:text-white">{secret.field}</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{secret.hint}</p>
                </div>
                <span className="text-xs text-gray-700 dark:text-gray-300">{statusBadge(secret.status)}</span>
              </div>
              <div className="mt-2">
                <CustodyCell row={secret} />
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono break-all">{secret.cid}</p>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {toDisplaySender(secret.setBy)} · {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
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
                {!isDelegation && (
                  <button
                    type="button"
                    disabled={isUpgrading}
                    onClick={() => void handleUpgradeCustody(secret.field)}
                    className="rounded-lg border border-blue-300 dark:border-blue-700 px-2 py-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
                  >
                    {isUpgrading ? 'Upgrading…' : 'Upgrade'}
                  </button>
                )}
                {hasActiveGrant && (
                  <button
                    type="button"
                    onClick={() => setRevokeField(secret.field)}
                    className="rounded-lg border border-red-300 dark:border-red-700 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    Revoke grant
                  </button>
                )}
              </div>
            </div>
          );
        })}
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
        entries={historyLoading ? [] : historyEntries}
        open={historyField !== null}
        onClose={() => setHistoryField(null)}
      />
      <RevokeGrantDialog
        field={revokeField}
        open={revokeField !== null}
        submitting={submitting}
        onClose={() => setRevokeField(null)}
        onConfirm={handleRevokeGrant}
      />
    </div>
  );
}
