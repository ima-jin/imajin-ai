'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useChatConfig } from '../ChatProvider';

/**
 * Resolves DIDs to display names via auth lookup.
 * Nicknames (from connections service) take priority over auth names.
 * SWR handles caching and deduplication — identical DID sets share one request.
 */
export function useDidNames(dids: string[]): Record<string, string> {
  const { chatUrl, connectionsUrl } = useChatConfig();

  const didsKey = useMemo(() => {
    const sorted = Array.from(new Set(dids)).sort();
    return sorted.join(',');
  }, [dids]);

  const { data: authNames = {} } = useSWR<Record<string, string>>(
    didsKey ? `${chatUrl}/_lookup_batch:${didsKey}` : null,
    async () => {
      const uniqueDids = didsKey.split(',').filter(Boolean);
      const results: Record<string, string> = {};
      await Promise.all(
        uniqueDids.map(async (did) => {
          try {
            const res = await fetch(
              `${chatUrl}/api/lookup/${encodeURIComponent(did)}`,
              { credentials: 'include' }
            );
            if (res.ok) {
              const data = await res.json();
              const identity = data.identity || data;
              const label = identity.name || (identity.handle ? `@${identity.handle}` : null);
              if (label) results[did] = label;
            }
          } catch {
            // Ignore — will show fallback
          }
        })
      );
      return results;
    }
  );

  const { data: nicknameData } = useSWR<Record<string, string>>(
    didsKey && connectionsUrl ? `${connectionsUrl}/_nicknames_batch:${didsKey}` : null,
    async () => {
      const uniqueDids = didsKey.split(',').filter(Boolean);
      try {
        const res = await fetch(`${connectionsUrl}/api/nicknames/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ dids: uniqueDids }),
        });
        if (!res.ok) return {};
        const data = await res.json();
        return data.nicknames ?? {};
      } catch {
        return {};
      }
    }
  );

  return useMemo(() => {
    const merged: Record<string, string> = { ...authNames };
    for (const [did, nickname] of Object.entries(nicknameData ?? {})) {
      if (nickname) merged[did] = nickname;
    }
    return merged;
  }, [authNames, nicknameData]);
}
