'use client';

import { useState } from 'react';
import { NavBar } from '@imajin/ui';
import { MediaManager } from './MediaManager';
import type { Identity } from '@imajin/auth';

interface Props {
  session: Identity;
}

export function MediaPageClient({ session }: Props) {
  const [search, setSearch] = useState('');
  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

  return (
    <>
      <NavBar currentService="Media" servicePrefix={servicePrefix} domain={domain}>
        <input
          type="text"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52 bg-[#252525] border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 transition-colors"
        />
      </NavBar>
      <div className="flex-1 overflow-hidden">
        <MediaManager session={session} search={search} />
      </div>
    </>
  );
}
