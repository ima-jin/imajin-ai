'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useChatConfig } from '../ChatProvider';

/**
 * Resolves DIDs to display names via auth lookup.
 * Nicknames (from connections service) take priority over auth names.
 * Caches results and deduplicates in-flight requests.
 * Only re-fetches when the set of DIDs actually changes.
 */
export function useDidNames(dids: string[]): Record<string, string> {
  const { chatUrl, connectionsUrl } = useChatConfig();
  const [names, setNames] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>());
  const cacheRef = useRef<Record<string, string>>({});
  const nicknameCacheRef = useRef<Record<string, string>>({});

  // Stable key: only changes when the actual set of DIDs changes
  const didsKey = useMemo(() => {
    const sorted = Array.from(new Set(dids)).sort();
    return sorted.join(',');
  }, [dids]);

  const resolve = useCallback(async (did: string) => {
    if (cacheRef.current[did] || pendingRef.current.has(did)) return;
    pendingRef.current.add(did);

    try {
      const res = await fetch(
        `${chatUrl}/api/lookup/${encodeURIComponent(did)}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = await res.json();
        const identity = data.identity || data;
        const label = identity.name || (identity.handle ? `@${identity.handle}` : null);
        if (label) {
          cacheRef.current[did] = label;
          setNames(prev => ({ ...prev, [did]: label }));
        }
      }
    } catch {
      // Ignore — will show fallback
    } finally {
      pendingRef.current.delete(did);
    }
  }, [chatUrl]);

  // Resolve auth names — only for DIDs not already cached
  useEffect(() => {
    const uniqueDids = didsKey.split(',').filter(Boolean);
    const uncached = uniqueDids.filter(did => !cacheRef.current[did]);
    uncached.forEach(resolve);
  }, [didsKey, resolve]);

  // Resolve nicknames — batch, only when DIDs change
  useEffect(() => {
    if (!connectionsUrl) return;
    const uniqueDids = didsKey.split(',').filter(Boolean);
    if (uniqueDids.length === 0) return;

    // Skip if all nicknames already cached
    const uncached = uniqueDids.filter(did => !(did in nicknameCacheRef.current));
    if (uncached.length === 0) return;

    (async () => {
      try {
        const res = await fetch(`${connectionsUrl}/api/nicknames/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ dids: uncached }),
        });
        if (res.ok) {
          const data = await res.json();
          const fetched: Record<string, string> = data.nicknames ?? {};
          let changed = false;
          for (const [did, nickname] of Object.entries(fetched)) {
            nicknameCacheRef.current[did] = nickname || '';
            if (nickname) changed = true;
          }
          // Mark DIDs with no nickname as resolved (empty string) to avoid re-fetching
          for (const did of uncached) {
            if (!(did in nicknameCacheRef.current)) {
              nicknameCacheRef.current[did] = '';
            }
          }
          if (changed) {
            setNames(prev => ({ ...prev }));
          }
        }
      } catch {
        // Graceful fallback — auth names still resolve
      }
    })();
  }, [didsKey, connectionsUrl]);

  // Nickname wins over auth name
  const merged: Record<string, string> = { ...cacheRef.current, ...names };
  for (const [did, nickname] of Object.entries(nicknameCacheRef.current)) {
    if (nickname) merged[did] = nickname;
  }
  return merged;
}
