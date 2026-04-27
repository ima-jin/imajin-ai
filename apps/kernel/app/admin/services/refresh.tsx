'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function ServicesRefresh() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleRefresh() {
    setLoading(true);
    router.refresh();
    // Give a moment for the refresh to register visually
    await new Promise((r) => setTimeout(r, 500));
    setLoading(false);
  }

  return (
    <button
      onClick={handleRefresh}
      disabled={loading}
      className="border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-primary hover:bg-gray-50 dark:hover:bg-surface-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {loading ? 'Refreshing…' : '↻ Refresh'}
    </button>
  );
}
