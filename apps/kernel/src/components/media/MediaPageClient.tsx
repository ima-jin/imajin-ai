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
    <div className="flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 shrink-0">
        <input
          type="text"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52 bg-[#252525] border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 transition-colors"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <MediaManager session={session} search={search} />
      </div>
    </div>
  );
}
