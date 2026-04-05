'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

/**
 * Resolves DIDs to display names via auth lookup.
 * Nicknames (from connections service) take priority over auth names.
 * Caches results and deduplicates in-flight requests.
 */
export function useDidNames(dids: string[]): Record<string, string> {
  const { chatUrl, connectionsUrl } = useChatConfig();
  const [names, setNames] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>());
  const cacheRef = useRef<Record<string, string>>({});
  const nicknameCacheRef = useRef<Record<string, string>>({});

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

  useEffect(() => {
    const uniqueDids = Array.from(new Set(dids));
    uniqueDids.forEach(resolve);
  }, [dids, resolve]);

  useEffect(() => {
    if (!connectionsUrl) return;
    const uniqueDids = Array.from(new Set(dids));
    if (uniqueDids.length === 0) return;

    (async () => {
      try {
        const res = await fetch(`${connectionsUrl}/api/nicknames/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ dids: uniqueDids }),
        });
        if (res.ok) {
          const data = await res.json();
          const fetched: Record<string, string> = data.nicknames ?? {};
          let changed = false;
          for (const [did, nickname] of Object.entries(fetched)) {
            if (nickname && nicknameCacheRef.current[did] !== nickname) {
              nicknameCacheRef.current[did] = nickname;
              changed = true;
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
  }, [dids, connectionsUrl]);

  // Nickname wins over auth name
  const merged: Record<string, string> = { ...cacheRef.current, ...names };
  for (const [did, nickname] of Object.entries(nicknameCacheRef.current)) {
    if (nickname) merged[did] = nickname;
  }
  return merged;
}
