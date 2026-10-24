'use client';

/**
 * /auth/corpus dashboard shell (#1731).
 *
 * Fetches corpus status from `/auth/corpus/api/status` (kernel-proxied to
 * the corpus service, keyed by the acting DID resolved server-side in
 * page.tsx) and renders the sources list, ingestion/error states, the "Load
 * new source" form, and per-source sync/remove actions.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { computeFreshness } from '../lib/freshness';
import { iconForSource, composeSource, SOURCE_TYPE_OPTIONS } from '../lib/source-type';

interface CorpusSourceFreshness {
  source: string;
  ownerDid?: string;
  lastSync: string;
  threadCount: number;
  warning?: string;
  credentialRef?: string;
  error?: string;
}

interface CorpusStatus {
  sources: CorpusSourceFreshness[];
  threadCount: number;
}

type StatusMessage = { type: 'success' | 'error'; text: string };

const FRESHNESS_DOT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

function FreshnessBadge({ lastSync }: Readonly<{ lastSync: string }>) {
  if (!lastSync) return <span className="text-xs text-gray-500">Not synced yet</span>;
  const freshness = computeFreshness(lastSync);
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${FRESHNESS_DOT[freshness.level]}`} title={freshness.label} />
      <span className="text-xs text-gray-500">{freshness.label}</span>
      {freshness.warningText && (
        <span className="text-xs text-red-400">— {freshness.warningText}</span>
      )}
    </div>
  );
}

function SourceRow({
  source,
  onSync,
  onRemove,
  syncing,
  removing,
}: Readonly<{
  source: CorpusSourceFreshness;
  onSync: (source: string) => void;
  onRemove: (source: string) => void;
  syncing: boolean;
  removing: boolean;
}>) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 bg-gray-900 rounded-lg border border-gray-800">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xl flex-shrink-0">{iconForSource(source.source)}</span>
        <div className="min-w-0">
          <p className="text-sm text-white font-medium truncate" title={source.source}>
            {source.source}
          </p>
          <p className="text-xs text-gray-400 break-all">Owner: {source.ownerDid ?? 'unresolved'}</p>
          <div className="flex flex-wrap items-center gap-3 mt-0.5">
            <span className="text-xs text-gray-500">{source.threadCount} threads</span>
            {source.error && <span className="text-xs text-gray-400">Last success:</span>}
            <FreshnessBadge lastSync={source.lastSync} />
          </div>
          {source.credentialRef && <p className="text-xs text-gray-400 mt-1">Connector: {source.credentialRef}</p>}
          {source.error && <p role="alert" className="text-sm text-red-400 mt-1 break-words">{source.error}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 sm:ml-3">
        <button
          type="button"
          onClick={() => onSync(source.source)}
          disabled={syncing}
          className="px-2.5 py-1 text-xs rounded-lg border border-gray-700 text-gray-300 hover:border-amber-500/40 hover:text-amber-400 transition disabled:opacity-40"
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        {confirmingRemove ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setConfirmingRemove(false);
                onRemove(source.source);
              }}
              disabled={removing}
              className="px-2.5 py-1 text-xs rounded-lg border border-red-800 text-red-400 hover:bg-red-900/20 transition disabled:opacity-40"
            >
              {removing ? 'Removing…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              className="px-2.5 py-1 text-xs rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 transition"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition"
            title="Remove source"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function LoadSourceForm({
  onSubmit,
  onCancel,
  submitting,
}: Readonly<{
  onSubmit: (sourceType: string, identifier: string, credentialRef?: string) => void;
  onCancel: () => void;
  submitting: boolean;
}>) {
  const [sourceType, setSourceType] = useState<string>(SOURCE_TYPE_OPTIONS[0].value);
  const [identifier, setIdentifier] = useState('');
  const [connectors, setConnectors] = useState<{ ref: string; label: string }[]>([]);
  const [credentialRef, setCredentialRef] = useState('');
  const [connectorError, setConnectorError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/auth/corpus/api/connectors', { credentials: 'include' })
      .then(async response => {
        if (!response.ok) throw new Error('Connector status unavailable');
        const body = await response.json() as { connectors: { ref: string; label: string }[] };
        if (active) setConnectors(body.connectors);
      })
      .catch(() => { if (active) setConnectorError('Could not load GitHub connectors. Please retry.'); });
    return () => { active = false; };
  }, []);

  const selected = SOURCE_TYPE_OPTIONS.find((opt) => opt.value === sourceType) ?? SOURCE_TYPE_OPTIONS[0];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!identifier.trim()) return;
        if (sourceType === 'github' && !credentialRef) return;
        onSubmit(sourceType, identifier.trim(), sourceType === 'github' ? credentialRef : undefined);
      }}
      className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3"
    >
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          aria-label="Source type"
          style={{ colorScheme: 'dark' }}
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className="px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
        >
          {SOURCE_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.icon} {opt.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder={selected.identifierHint}
          className="flex-1 px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
      </div>
      {sourceType === 'github' && (
        <div className="space-y-2">
          <label htmlFor="corpus-github-connector" className="block text-sm text-gray-300">GitHub connector</label>
          <select
            id="corpus-github-connector"
            style={{ colorScheme: 'dark' }}
            value={credentialRef}
            onChange={event => setCredentialRef(event.target.value)}
            className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-sm text-white"
            required
          >
            <option value="">Choose a connector</option>
            {connectors.map(connector => <option key={connector.ref} value={connector.ref}>{connector.label}</option>)}
          </select>
          {connectorError && <p role="alert" className="text-sm text-red-400">{connectorError}</p>}
          <p className="text-xs text-gray-400">
            No token is needed here. <Link className="text-amber-400 underline" href="/auth/connectors">Manage profile connectors</Link>.
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !identifier.trim() || (sourceType === 'github' && !credentialRef)}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold rounded-lg transition disabled:opacity-40"
        >
          {submitting ? 'Loading…' : 'Load source'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function CorpusManagerShell({ did }: Readonly<{ did: string }>) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<CorpusStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncingSource, setSyncingSource] = useState<string | null>(null);
  const [removingSource, setRemovingSource] = useState<string | null>(null);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    void fetchStatus();
  }, [did]);

  function showMessage(type: StatusMessage['type'], text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  }

  async function fetchStatus() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/auth/corpus/api/status', { credentials: 'include' });
      if (res.ok) {
        setStatus((await res.json()) as CorpusStatus);
      } else {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error || 'Failed to load corpus status.');
      }
    } catch {
      setLoadError('Network error while loading corpus status.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadSource(sourceType: string, identifier: string, credentialRef?: string) {
    setSubmitting(true);
    try {
      const source = composeSource(sourceType, identifier);
      const res = await fetch('/auth/corpus/api/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sourceType, source, ...(credentialRef ? { credentialRef } : {}) }),
      });
      if (res.ok) {
        showMessage('success', `Started loading ${source}.`);
        setSourceErrors(errors => ({ ...errors, [source]: undefined }));
        setShowForm(false);
        await fetchStatus();
      } else {
        const body = await res.json().catch(() => ({}));
        showMessage('error', body.error || 'Failed to load source.');
      }
    } catch {
      showMessage('error', 'Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync(source: string) {
    setSyncingSource(source);
    try {
      const res = await fetch('/auth/corpus/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ source }),
      });
      if (res.ok) {
        showMessage('success', `Sync started for ${source}.`);
        setSourceErrors(errors => ({ ...errors, [source]: undefined }));
        await fetchStatus();
      } else {
        const body = await res.json().catch(() => ({}));
        setSourceErrors(errors => ({ ...errors, [source]: body.error || 'Failed to sync source.' }));
        await fetchStatus();
      }
    } catch {
      showMessage('error', 'Network error. Please try again.');
    } finally {
      setSyncingSource(null);
    }
  }

  async function handleRemove(source: string) {
    setRemovingSource(source);
    try {
      const res = await fetch('/auth/corpus/api/source', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ source }),
      });
      if (res.ok) {
        showMessage('success', `Removed ${source}.`);
        await fetchStatus();
      } else {
        const body = await res.json().catch(() => ({}));
        showMessage('error', body.error || 'Failed to remove source.');
      }
    } catch {
      showMessage('error', 'Network error. Please try again.');
    } finally {
      setRemovingSource(null);
    }
  }

  const sources = status?.sources ?? [];
  const totalThreads = status?.threadCount ?? 0;

  let sourcesContent: React.ReactNode;
  if (loading) {
    sourcesContent = <p className="text-sm text-gray-500">Loading sources…</p>;
  } else if (loadError) {
    sourcesContent = <p className="text-sm text-red-400">{loadError}</p>;
  } else if (sources.length === 0) {
    sourcesContent = (
      <div className="text-center py-8">
        <p className="text-2xl mb-3">📚</p>
        <p className="text-sm text-gray-500">No sources loaded yet.</p>
      </div>
    );
  } else {
    sourcesContent = (
      <div className="space-y-2">
        {sources.map((source) => (
          <SourceRow
            key={source.source}
            source={{ ...source, error: sourceErrors[source.source] ?? source.error }}
            onSync={handleSync}
            onRemove={handleRemove}
            syncing={syncingSource === source.source}
            removing={removingSource === source.source}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Corpus</h1>
          <p className="text-gray-400 text-sm mt-1">
            Manage the sources loaded into this identity&apos;s corpus.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold rounded-lg transition"
          >
            Load new source
          </button>
        )}
      </div>

      {message && (
        <div
          className={`p-4 rounded-lg border ${
            message.type === 'success'
              ? 'bg-green-900/20 border-green-800 text-green-400'
              : 'bg-red-900/20 border-red-800 text-red-400'
          }`}
        >
          {message.text}
        </div>
      )}

      {showForm && (
        <LoadSourceForm
          onSubmit={handleLoadSource}
          onCancel={() => setShowForm(false)}
          submitting={submitting}
        />
      )}

      {/* Usage stats */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Usage</h2>
        <p className="text-2xl font-semibold text-white">{totalThreads}</p>
        <p className="text-sm text-gray-500">
          thread{totalThreads === 1 ? '' : 's'} indexed across {sources.length} source{sources.length === 1 ? '' : 's'}
        </p>
      </div>

      {/* Sources list */}
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-6">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Sources</h2>
        <p className="text-sm text-gray-400 mb-6">Where this identity&apos;s corpus threads come from.</p>

        {sourcesContent}
      </div>
    </div>
  );
}
