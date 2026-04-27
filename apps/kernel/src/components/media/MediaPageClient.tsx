'use client';

import { useState } from 'react';
import { MediaManager } from './MediaManager';
import type { Identity } from '@imajin/auth';

interface Props {
  session: Identity;
}

export function MediaPageClient({ session }: Props) {
  const [search, setSearch] = useState('');

  return (
    <div className="flex-1 overflow-hidden">
      <div className="px-4 py-3">
        <input
          type="text"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52 bg-[#252525] border border-white/10 px-3 py-1.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-imajin-orange transition-colors"
        />
      </div>
      <MediaManager session={session} search={search} />
    </div>
  );
}
