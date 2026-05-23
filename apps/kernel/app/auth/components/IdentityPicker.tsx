'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface IdentityResult {
  did: string;
  handle: string | null;
  name: string | null;
  scope: string;
  subtype: string | null;
  avatarUrl: string | null;
  avatarAssetId: string | null;
}

interface IdentityPickerProps {
  onSelect: (identity: IdentityResult) => void;
  placeholder?: string;
  excludeDids?: string[];
  className?: string;
}

export default function IdentityPicker({
  onSelect,
  placeholder = 'Search by handle or name…',
  excludeDids = [],
  className = '',
}: Readonly<IdentityPickerProps>) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IdentityResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q || q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/auth/api/search?q=${encodeURIComponent(q)}&limit=5`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        const filtered = (data.results as IdentityResult[]).filter(
          (r) => !excludeDids.includes(r.did)
        );
        setResults(filtered);
        setOpen(filtered.length > 0);
        setHighlightedIndex(0);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [excludeDids]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSelect(identity: IdentityResult) {
    onSelect(identity);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = results[highlightedIndex];
      if (selected) handleSelect(selected);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function resolveAvatarSrc(identity: IdentityResult): string | null {
    const mediaUrl = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';
    if (identity.avatarAssetId && mediaUrl) {
      return `${mediaUrl}/api/media/${identity.avatarAssetId}`;
    }
    if (identity.avatarUrl) return identity.avatarUrl;
    return null;
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-transparent pr-8"
        />
        {loading && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500">
            …
          </span>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-[#0a0a0a] border border-gray-800 rounded-lg shadow-xl overflow-hidden">
          {results.length === 0 ? (
            <div className="px-3 py-2.5 text-sm text-gray-500">No results</div>
          ) : (
            <ul className="max-h-60 overflow-y-auto">
              {results.map((identity, index) => {
                const avatarSrc = resolveAvatarSrc(identity);
                const isHighlighted = index === highlightedIndex;
                return (
                  <li key={identity.did}>
                    <button
                      type="button"
                      onClick={() => handleSelect(identity)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                        isHighlighted
                          ? 'bg-gray-800/80'
                          : 'hover:bg-gray-800/50'
                      }`}
                    >
                      {avatarSrc ? (
                        <img
                          src={avatarSrc}
                          alt=""
                          className="w-8 h-8 rounded-full object-cover border border-gray-800 shrink-0"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs text-gray-500 shrink-0">
                          {identity.name?.[0]?.toUpperCase() ?? '?'}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm text-white font-medium truncate">
                          {identity.name || identity.handle || 'Unnamed'}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {identity.handle ? `@${identity.handle}` : identity.did.slice(0, 20) + '…'}
                          {' · '}
                          <span className="capitalize">{identity.scope}</span>
                          {identity.subtype ? `/${identity.subtype}` : ''}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
