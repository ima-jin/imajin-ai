'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DidShareList, DidShareEntry } from '@imajin/fair';

interface ResolvedProfile {
  name: string;
  handle?: string;
  avatar?: string;
}

interface Connection {
  did: string;
  name: string | null;
  handle: string | null;
  avatar?: string | null;
}

interface DidShareListEditorProps {
  value: DidShareList;
  onChange: (value: DidShareList) => void;
  readOnly?: boolean;
  className?: string;
  defaultDid?: string;
  showFixed?: boolean;
  connectionsUrl?: string;
  resolveProfile?: (did: string) => Promise<ResolvedProfile | null>;
}

const ROLE_OPTIONS = [
  'creator', 'collaborator', 'producer', 'performer',
  'platform', 'venue', 'distributor', 'label', 'other',
];

const SUM_TOLERANCE = 1e-6;

// ─── ResolvedDidChip ───────────────────────────────────────────────────────

function ResolvedDidChip({
  did,
  profile,
  onClear,
  readOnly,
}: Readonly<{
  did: string;
  profile: ResolvedProfile | null;
  onClear: () => void;
  readOnly?: boolean;
}>) {
  const displayName = profile?.name || did.slice(0, 16) + '…';
  const handle = profile?.handle;
  const avatar = profile?.avatar;

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(did).catch(() => {});
    }
  };

  return (
    <div
      className="flex-1 flex items-center gap-2 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 min-w-0 cursor-pointer hover:border-gray-600 transition"
      title={did}
      onClick={handleCopy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCopy();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className="w-5 h-5 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-[10px] font-semibold flex-shrink-0">
          {(displayName).charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-xs text-gray-200 truncate">{displayName}</span>
      {handle && (
        <span className="text-xs text-gray-500 truncate">@{handle}</span>
      )}
      {!readOnly && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="ml-auto text-gray-600 hover:text-red-400 transition text-xs px-1"
          title="Clear"
          type="button"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── InlineDidPicker ───────────────────────────────────────────────────────

function InlineDidPicker({
  connectionsUrl,
  onSelect,
  readOnly,
}: Readonly<{
  connectionsUrl?: string;
  onSelect: (did: string) => void;
  readOnly?: boolean;
}>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch connections when picker opens and URL is available
  useEffect(() => {
    if (!connectionsUrl || connections.length > 0) return;
    setLoading(true);
    fetch(connectionsUrl)
      .then((r) => r.json())
      .then((data) => {
        const list = (data.connections || []).map((c: Record<string, unknown>) => ({
          did: String(c.did || ''),
          name: c.name ? String(c.name) : null,
          handle: c.handle ? String(c.handle) : null,
          avatar: c.avatar ? String(c.avatar) : null,
        })) as Connection[];
        setConnections(list);
      })
      .catch(() => {
        setConnections([]);
      })
      .finally(() => setLoading(false));
  }, [connectionsUrl, connections.length]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const isRawDid = query.trim().startsWith('did:');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        (c.handle || '').toLowerCase().includes(q) ||
        (c.name || '').toLowerCase().includes(q) ||
        c.did.toLowerCase().includes(q)
    );
  }, [query, connections]);

  const handleSelect = (did: string) => {
    onSelect(did);
    setQuery('');
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = query.trim();
      if (isRawDid) {
        handleSelect(trimmed);
      } else if (filtered.length > 0) {
        handleSelect(filtered[0].did);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showDropdown = open && (filtered.length > 0 || isRawDid || loading);

  return (
    <div ref={wrapperRef} className="flex-1 relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={connectionsUrl ? 'Search connections or paste DID…' : 'did:key:...'}
        readOnly={readOnly}
        className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 read-only:opacity-60"
      />
      {showDropdown && (
        <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-gray-700 rounded max-h-36 overflow-y-auto shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-gray-500">Loading…</div>
          ) : (
            <>
              {isRawDid && (
                <button
                  onClick={() => handleSelect(query.trim())}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#252525] transition text-left"
                  type="button"
                >
                  <span className="text-xs text-orange-400">Use raw DID:</span>
                  <span className="text-xs text-gray-300 truncate">{query.trim()}</span>
                </button>
              )}
              {filtered.map((conn) => (
                <button
                  key={conn.did}
                  onClick={() => handleSelect(conn.did)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#252525] transition text-left"
                  type="button"
                >
                  {conn.avatar ? (
                    <img
                      src={conn.avatar}
                      alt=""
                      className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-[10px] font-semibold flex-shrink-0">
                      {(conn.name || conn.handle || conn.did).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <span className="text-xs text-gray-200 truncate">
                      {conn.name || (conn.handle ? `@${conn.handle}` : conn.did.slice(0, 20) + '…')}
                    </span>
                    {conn.handle && conn.name && (
                      <span className="text-xs text-gray-500 ml-1">@{conn.handle}</span>
                    )}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && !isRawDid && (
                <div className="px-3 py-2 text-xs text-gray-500">
                  {connections.length === 0 ? 'No connections available.' : 'No matches.'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DidShareListEditor ────────────────────────────────────────────────────

export function DidShareListEditor({
  value,
  onChange,
  readOnly = false,
  className = '',
  defaultDid,
  showFixed = false,
  connectionsUrl,
  resolveProfile,
}: Readonly<DidShareListEditorProps>) {
  const [resolvedCache, setResolvedCache] = useState<Record<string, ResolvedProfile | null>>({});

  const totalShare = useMemo(
    () => value.reduce((sum: number, e: DidShareEntry) => sum + e.share, 0),
    [value],
  );

  const isValid = Math.abs(totalShare - 1.0) <= SUM_TOLERANCE;
  const isOver = totalShare > 1.0 + SUM_TOLERANCE;

  const update = (i: number, patch: Partial<DidShareEntry>) => {
    const next = value.map((e: DidShareEntry, idx: number) => (idx === i ? { ...e, ...patch } : e));
    onChange(next);
  };

  const remove = (i: number) => {
    onChange(value.filter((_e: DidShareEntry, idx: number) => idx !== i));
  };

  const add = () => {
    onChange([
      ...value,
      {
        did: defaultDid ?? '',
        role: 'collaborator',
        share: 0,
      },
    ]);
  };

  // Auto-resolve existing DIDs on mount / when resolveProfile changes
  useEffect(() => {
    if (!resolveProfile) return;
    const dids = value.map((e) => e.did).filter(Boolean);
    const uniqueDids = [...new Set(dids)].filter((did) => !(did in resolvedCache));
    if (uniqueDids.length === 0) return;

    Promise.all(
      uniqueDids.map(async (did) => {
        try {
          const profile = await resolveProfile(did);
          return { did, profile };
        } catch {
          return { did, profile: null };
        }
      })
    ).then((results) => {
      setResolvedCache((prev) => {
        const next = { ...prev };
        for (const { did, profile } of results) {
          next[did] = profile;
        }
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveProfile, value.map((e) => e.did).join(',')]);

  return (
    <div className={`space-y-3 ${className}`}>
      {value.map((entry, i) => (
        <div key={i} className="bg-[#252525] rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            {entry.did ? (
              <ResolvedDidChip
                did={entry.did}
                profile={resolvedCache[entry.did] ?? null}
                onClear={() => update(i, { did: '' })}
                readOnly={readOnly}
              />
            ) : (
              <InlineDidPicker
                connectionsUrl={connectionsUrl}
                onSelect={(did) => update(i, { did })}
                readOnly={readOnly}
              />
            )}
            <select
              value={entry.role}
              onChange={(e) => update(i, { role: e.target.value })}
              disabled={readOnly}
              className="bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 disabled:opacity-60"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {!readOnly && (
              <button
                onClick={() => remove(i)}
                className="text-gray-600 hover:text-red-400 transition text-sm px-1"
                title="Remove"
                type="button"
              >
                ✕
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={Math.round(entry.share * 1000) / 10}
              onChange={(e) => update(i, { share: Number.parseFloat(e.target.value) / 100 })}
              disabled={readOnly}
              className="flex-1 accent-orange-500 disabled:opacity-60"
            />
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={(entry.share * 100).toFixed(1)}
              onChange={(e) => update(i, { share: Number.parseFloat(e.target.value) / 100 })}
              readOnly={readOnly}
              className="w-16 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 text-right read-only:opacity-60"
            />
            <span className="text-xs text-gray-500">%</span>
          </div>
          <input
            type="text"
            value={entry.name ?? ''}
            onChange={(e) => update(i, { name: e.target.value || undefined })}
            placeholder="Name (optional)"
            readOnly={readOnly}
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-500 placeholder-gray-700 focus:outline-none focus:border-orange-500 read-only:opacity-60"
          />
        </div>
      ))}

      {!readOnly && (
        <button
          onClick={add}
          type="button"
          className="w-full py-1.5 rounded border border-dashed border-gray-700 text-xs text-gray-500 hover:border-orange-500 hover:text-orange-400 transition"
        >
          + Add contributor
        </button>
      )}

      <div className="flex items-center justify-between text-xs">
        <span
          className={(() => {
            if (isValid) return 'text-gray-500';
            if (isOver) return 'text-red-400 font-medium';
            return 'text-orange-400 font-medium';
          })()}
        >
          Total: {(totalShare * 100).toFixed(1)}%
          {!isValid && (
            <span className="ml-1">
              {isOver ? '(must be ≤ 100%)' : '(must equal 100%)'}
            </span>
          )}
        </span>
        <span className="text-gray-600">
          {value.length} {value.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
    </div>
  );
}
