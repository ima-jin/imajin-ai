'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

/**
 * Resolves DIDs to display names via auth lookup.
 * Caches results and deduplicates in-flight requests.
 */
export function useDidNames(dids: string[]): Record<string, string> {
  const { chatUrl } = useChatConfig();
  const [names, setNames] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>());
  const cacheRef = useRef<Record<string, string>>({});

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
    const uniqueDids = [...new Set(dids)].filter(d => !cacheRef.current[d]);
    uniqueDids.forEach(resolve);
  }, [dids, resolve]);

  // Return merged cache + state
  return { ...cacheRef.current, ...names };
}
