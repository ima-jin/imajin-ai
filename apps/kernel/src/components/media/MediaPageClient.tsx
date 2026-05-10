'use client';

import { useState } from 'react';
import { AppShell } from '@imajin/ui';
import { MediaManager } from './MediaManager';
import type { Identity } from '@imajin/auth';

interface Props {
  session: Identity;
}

export function MediaPageClient({ session }: Props) {
  const [search, setSearch] = useState('');

  return (
    <AppShell>
      <AppShell.Header className="px-4 py-3">
        <input
          type="text"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52 bg-[#252525] border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 transition-colors"
        />
      </AppShell.Header>
      <AppShell.Body className="flex flex-col">
        <MediaManager session={session} search={search} />
      </AppShell.Body>
    </AppShell>
  );
}
