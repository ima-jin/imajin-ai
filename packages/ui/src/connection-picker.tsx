'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { ConnectionRelationshipFilter, filterRelationships, type RelationshipLabel, type RelationshipFilter } from './connection-relationships';

interface Connection {
  did: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  relationshipLabel?: RelationshipLabel | null;
}

export interface ConnectionPickerProps {
  connectionsUrl: string;
  /** Defaults to /auth/api/search on the connections URL's origin. */
  searchUrl?: string;
  /** Defaults to /connections/api/invites on the connections URL's origin. */
  invitesUrl?: string;
  /** Change when an SDK consumer switches authenticated/effective identity without remounting. */
  identityKey?: string;
  excludeDids?: string[];
  onSelect: (connection: Connection) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shown when the user has no connections at all (not when a search matches nothing). Defaults to "No connections available." */
  emptyMessage?: ReactNode;
  /** Show relationship labels and filters, with clients first and all connections initially visible. */
  relationshipLabels?: boolean;
}

const DEFAULT_EMPTY_MESSAGE = 'No connections available.';

/** A failed load, carrying a message that is safe to show the user as-is. */
class ConnectionsLoadError extends Error {}

function describeLoadFailure(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to load connections.';
  if (status === 403) return "You don't have permission to view these connections.";
  return `Failed to load connections (HTTP ${status}).`;
}

/** Fetch the connection list, throwing a {@link ConnectionsLoadError} for any non-2xx response so it never reads as an empty list. */
async function fetchConnections(url: string): Promise<Connection[]> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new ConnectionsLoadError(describeLoadFailure(res.status));
  const data = await res.json();
  return data.connections ?? [];
}

function endpointOnOrigin(connectionsUrl: string, path: string): string {
  if (connectionsUrl.startsWith('//')) return `//${new URL('https:' + connectionsUrl).host}${path}`;
  if (/^https?:\/\//.test(connectionsUrl)) return new URL(path, connectionsUrl).toString();
  return path;
}

interface IdentityResult {
  did: string;
  name: string | null;
  handle: string | null;
}

function IdentityLookup({
  query, searchUrl, invitesUrl, excludedDids, pendingDids, onRequested,
}: Readonly<{
  query: string;
  searchUrl: string;
  invitesUrl: string;
  excludedDids: Set<string>;
  pendingDids: Set<string>;
  onRequested: (did: string) => void;
}>) {
  const [results, setResults] = useState<IdentityResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendingDid, setSendingDid] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(async () => {
      try {
        const url = new URL(searchUrl, globalThis.location.href);
        url.searchParams.set('q', query);
        const target = searchUrl.startsWith('/') && !searchUrl.startsWith('//')
          ? `${url.pathname}${url.search}` : url.toString();
        const res = await fetch(target, { credentials: 'include', signal: abort.signal });
        if (!res.ok) throw new Error('Identity search is unavailable. Try again.');
        const data = await res.json();
        if (!abort.signal.aborted) setResults(data.results ?? []);
      } catch {
        if (!abort.signal.aborted) setError('Identity search is unavailable. Try again.');
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, searchUrl]);

  async function sendRequest(did: string) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || sending.current || excludedDids.has(did) || pendingDids.has(did)) return;
    sending.current = true;
    setSendingDid(did);
    setError(null);
    try {
      const res = await fetch(invitesUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toDid: did }),
        signal,
      });
      if (!res.ok) throw new Error('request failed');
      if (!signal.aborted) onRequested(did);
    } catch {
      if (!signal.aborted) setError('Could not send connection request. Please try again.');
    } finally {
      sending.current = false;
      if (!signal.aborted) setSendingDid(null);
    }
  }

  const visible = results.filter(result => !excludedDids.has(result.did));
  return (
    <div className="space-y-2" aria-live="polite">
      {loading && <p className="text-sm text-gray-500 px-1">Searching identities...</p>}
      {error && <p role="alert" className="text-sm text-red-400 px-1">{error}</p>}
      {!loading && !error && visible.length === 0 && (
        <p className="text-sm text-gray-500 px-1">No matching identities.</p>
      )}
      {visible.map(identity => (
        <div key={identity.did} className="space-y-1 border border-gray-700 bg-gray-900 px-3 py-2">
          <div className="text-sm font-medium text-white break-words">{identity.name || identity.handle || identity.did}</div>
          {identity.handle && <div className="text-xs text-gray-400">@{identity.handle}</div>}
          <div className="text-xs text-gray-400 break-all">{identity.did}</div>
          {pendingDids.has(identity.did) ? (
            <output className="text-sm text-orange-400">Connection request pending — awaiting acceptance.</output>
          ) : (
            <button type="button"
              onClick={() => sendRequest(identity.did)}
              disabled={sendingDid !== null}
              className="px-3 py-2 text-sm text-orange-400 border border-gray-600 hover:bg-gray-800 disabled:opacity-50"
            >
              {sendingDid === identity.did ? 'Sending request...' : 'Send connection request'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function ConnectionPicker(props: Readonly<ConnectionPickerProps>) {
  const [identityRevision, setIdentityRevision] = useState(0);
  useEffect(() => {
    const reset = () => setIdentityRevision(revision => revision + 1);
    globalThis.addEventListener('imajin:acting-as-changed', reset);
    return () => globalThis.removeEventListener('imajin:acting-as-changed', reset);
  }, []);
  return <ConnectionPickerContent key={`${props.connectionsUrl}:${props.identityKey ?? ''}:${identityRevision}`} {...props} />;
}

function ConnectionPickerContent({
  connectionsUrl,
  searchUrl = endpointOnOrigin(connectionsUrl, '/auth/api/search'),
  invitesUrl = endpointOnOrigin(connectionsUrl, '/connections/api/invites'),
  excludeDids = [],
  onSelect,
  placeholder = 'Search connections...',
  disabled = false,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  relationshipLabels = false,
}: Readonly<ConnectionPickerProps>) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [relationshipFilter, setRelationshipFilter] = useState<RelationshipFilter>('all');
  const [pendingDids, setPendingDids] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchConnections(connectionsUrl)
      .then(list => {
        if (!cancelled) setConnections(list);
      })
      .catch(err => {
        if (!cancelled) {
          setConnections([]);
          setError(err instanceof ConnectionsLoadError ? err.message : 'Failed to load connections');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionsUrl]);

  const excludeSet = new Set(excludeDids);
  const available = connections.filter(c => !excludeSet.has(c.did));
  const query = search.trim().replace(/^@/, '');
  const matchQuery = query.toLowerCase();
  const matching = query
    ? available.filter(c =>
        (c.handle || '').toLowerCase().includes(matchQuery) ||
        (c.name || '').toLowerCase().includes(matchQuery) ||
        c.did.toLowerCase().includes(matchQuery)
      )
    : available;
  const filtered = relationshipLabels ? filterRelationships(matching, relationshipFilter) : matching;

  return (
    <div className="space-y-2">
      {relationshipLabels && (
        <ConnectionRelationshipFilter value={relationshipFilter} onChange={setRelationshipFilter} disabled={disabled || loading || error !== null} />
      )}
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || loading || error !== null}
        className="w-full px-3 py-2 text-sm border border-gray-600 rounded-lg bg-gray-900 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50"
      />
      {(() => {
        if (loading) return <p className="text-sm text-gray-500 px-1">Loading connections...</p>;
        if (error) return <p role="alert" className="text-sm text-red-400 px-1">{error}</p>;
        if (filtered.length === 0) return (
        <p className="text-sm text-gray-500 px-1">
          {available.length === 0 ? emptyMessage : 'No matching connections.'}
        </p>
        );
        return (
        <div className="space-y-0 max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900">
          {filtered.map(conn => (
            <button type="button"
              key={conn.did}
              onClick={() => { onSelect(conn); setSearch(''); }}
              disabled={disabled}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-800 transition text-left disabled:opacity-50"
            >
              {conn.avatar ? (
                <img
                  src={conn.avatar}
                  alt={conn.name || conn.handle || conn.did}
                  className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-sm font-semibold flex-shrink-0">
                  {(conn.name || conn.handle || conn.did).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">
                  {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 20) + '...')}
                </div>
                {conn.handle && conn.name && (
                  <div className="text-xs text-gray-400 truncate">@{conn.handle}</div>
                )}
                {relationshipLabels && (
                  <div className="text-xs text-amber-400 capitalize">{conn.relationshipLabel ?? 'Unset'}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      );
      })()}
      {!loading && !error && !disabled && matching.length === 0 && query.length >= 2 && (
        <IdentityLookup
          key={`${query}:${searchUrl}:${invitesUrl}`}
          query={query}
          searchUrl={searchUrl}
          invitesUrl={invitesUrl}
          excludedDids={new Set([...excludeDids, ...connections.map(connection => connection.did)])}
          pendingDids={pendingDids}
          onRequested={did => setPendingDids(previous => new Set([...previous, did]))}
        />
      )}
    </div>
  );
}
