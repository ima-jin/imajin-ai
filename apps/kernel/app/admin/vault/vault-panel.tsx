'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { computeCid } from '@imajin/cid';
import { HistoryDialog } from './history-dialog';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { SetSecretDialog } from './set-secret-dialog';
import type {
  AdminEventsApiResponse,
  RotateSecretInput,
  SetSecretInput,
  VaultHistoryApiResponse,
  VaultHistoryEntry,
  VaultListApiRow,
  VaultSecretRow,
  VaultWriteApiResponse,
} from './types';

ed25519.etc.sha512Sync = (...messages) => sha512(ed25519.etc.concatBytes(...messages));

interface VaultSignedPayload {
  version: number;
  field: string;
  cid: string;
  encrypted: string;
  nonce: string;
  senderDid: string;
  senderPubkey: string;
  keyId: string;
  timestamp: string;
}

interface VaultSignedRequestBody extends VaultSignedPayload {
  signature: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort((a, b) => a.localeCompare(b));
  const pairs = keys
    .filter((key) => objectValue[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key])}`);
  return `{${pairs.join(',')}}`;
}

async function deriveKeyId(senderPubkeyHex: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', hexToBytes(senderPubkeyHex));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

async function encryptInBrowser(plaintext: string): Promise<{ encrypted: string; nonce: string }> {
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintextBytes);
  return {
    encrypted: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(nonce),
  };
}

async function buildSignedVaultBody(field: string, value: string): Promise<VaultSignedRequestBody> {
  const { encrypted, nonce } = await encryptInBrowser(value);
  const privateKeyFactory =
    (ed25519.utils as { randomPrivateKey?: () => Uint8Array; randomSecretKey?: () => Uint8Array });
  const privateKey = privateKeyFactory.randomPrivateKey?.() ?? privateKeyFactory.randomSecretKey?.();
  if (!privateKey) {
    throw new Error('Unable to generate vault signing key');
  }

  const senderPubkey = bytesToHex(ed25519.getPublicKey(privateKey));
  const senderDid = `did:imajin:${senderPubkey.slice(0, 16)}`;
  const cid = await computeCid({ encrypted, nonce });
  const keyId = await deriveKeyId(senderPubkey);
  const timestamp = new Date().toISOString();

  const payload: VaultSignedPayload = {
    version: 1,
    field,
    cid,
    encrypted,
    nonce,
    senderDid,
    senderPubkey,
    keyId,
    timestamp,
  };

  const signature = bytesToHex(ed25519.sign(new TextEncoder().encode(canonicalize(payload)), privateKey));
  return { ...payload, signature };
}

function createHint(value: string, hint: string): string {
  const source = hint.trim() || value.trim();
  if (!source) return '••••';
  return `${source.slice(0, 4)}...`;
}

function statusBadge(status: VaultSecretRow['status']): string {
  return status === 'confirmed' ? '🟢 confirmed' : '🟡 pending';
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
    const intervalId = window.setInterval(() => {
      void refreshStatuses();
    }, 8000);
    return () => window.clearInterval(intervalId);
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

  async function handleSetSecret(input: SetSecretInput): Promise<void> {
    setSubmitting(true);
    try {
      const signedBody = await buildSignedVaultBody(input.field, input.value);
      const response = await fetch('/api/vault/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signedBody),
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
      const signedBody = await buildSignedVaultBody(input.field, input.value);
      const response = await fetch('/api/vault/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signedBody),
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-5 text-sm text-gray-500 dark:text-gray-400">
                    Loading vault entries…
                  </td>
                </tr>
              )}
              {!loading && sortedSecrets.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-5 text-sm text-gray-500 dark:text-gray-400">
                    No secrets found yet.
                  </td>
                </tr>
              )}
              {sortedSecrets.map((secret) => (
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
        entries={historyLoading ? [] : historyEntries}
        open={historyField !== null}
        onClose={() => setHistoryField(null)}
      />
    </div>
  );
}
