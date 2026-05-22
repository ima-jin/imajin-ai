'use client';

import { useState } from 'react';

interface ReAuthBannerShellProps {
  children: React.ReactNode;
}

export function ReAuthBannerShell({ children }: ReAuthBannerShellProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="relative bg-gradient-to-r from-orange-500/10 to-amber-500/10 border border-orange-500/20 rounded-2xl p-4 mb-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-2xl shrink-0">🎟</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">Already have a ticket?</p>
          <div className="mt-1">{children}</div>
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-gray-400 hover:text-gray-200 transition shrink-0 p-1"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
