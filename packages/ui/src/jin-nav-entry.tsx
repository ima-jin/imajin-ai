'use client';

import React, { useEffect, useState } from 'react';
import { getActingAsHeaders } from './acting-as';

interface InboxAttention {
  canAccess: boolean;
  pending: number;
}

/** Kernel navigation, not an installed app: stays visible outside mobile menus. */
export function JinNavEntry({ href, identityDid }: Readonly<{ href: string; identityDid?: string | null }>) {
  const [attention, setAttention] = useState<InboxAttention | null>(null);

  useEffect(() => {
    setAttention(null);
    if (!identityDid) return;
    let controller: AbortController | undefined;
    let generation = 0;

    async function refresh() {
      controller?.abort();
      controller = new AbortController();
      const requestGeneration = ++generation;
      try {
        const response = await fetch(`${href}/api/operator-approvals?view=acting&count=true`, {
          credentials: 'include',
          cache: 'no-store',
          headers: getActingAsHeaders(),
          signal: controller.signal,
        });
        const data = response.ok ? await response.json() as {
          canAccess?: boolean; pending?: number; personalInbox?: { pending: number };
        } : null;
        if (generation !== requestGeneration) return;
        setAttention(data ? {
          canAccess: data.canAccess === true,
          pending: (data.pending ?? 0) + (data.personalInbox?.pending ?? 0),
        } : null);
      } catch (error) {
        if (generation !== requestGeneration) return;
        console.error('Jin navigation: Inbox attention unavailable', error);
        setAttention(null);
      }
    }
    function storageChanged(event: StorageEvent) {
      if (event.key === null || event.key === 'imajin:acting-as') scopeChanged();
    }

    function scopeChanged() {
      setAttention(null);
      void refresh();
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    globalThis.addEventListener('focus', refresh);
    globalThis.addEventListener('jin:operator-approvals-refresh', refresh);
    globalThis.addEventListener('imajin:acting-as-changed', scopeChanged);
    globalThis.addEventListener('imajin:session-changed', scopeChanged);
    globalThis.addEventListener('storage', storageChanged);
    return () => {
      generation++;
      controller?.abort();
      clearInterval(interval);
      globalThis.removeEventListener('focus', refresh);
      globalThis.removeEventListener('jin:operator-approvals-refresh', refresh);
      globalThis.removeEventListener('imajin:acting-as-changed', scopeChanged);
      globalThis.removeEventListener('imajin:session-changed', scopeChanged);
      globalThis.removeEventListener('storage', storageChanged);
    };
  }, [href, identityDid]);

  if (!identityDid || !attention?.canAccess) return null;
  const label = attention.pending > 0
    ? `/jin — ${attention.pending} pending Inbox approvals` : '/jin — operator console';
  return (
    <a href={href} aria-label={label}
      className="inline-flex shrink-0 min-h-[44px] items-center gap-2 border border-amber-500/50 bg-amber-500/10 px-3 font-mono text-sm font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500 no-underline">
      <span>/jin</span>
      {attention.pending > 0 && (
        <span aria-hidden="true" className="rounded-full bg-orange-600 px-1.5 text-xs font-bold text-white">
          {attention.pending > 99 ? '99+' : attention.pending}
        </span>
      )}
    </a>
  );
}
