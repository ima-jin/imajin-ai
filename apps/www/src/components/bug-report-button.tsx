'use client';

import { useState } from 'react';
import { BugReportModal } from './bug-report-modal';

export function BugReportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Report a bug"
        aria-label="Report a bug"
        className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg hover:bg-orange-400 transition-colors"
      >
        <span className="text-xl" aria-hidden>🐛</span>
      </button>

      {open && <BugReportModal onClose={() => setOpen(false)} />}
    </>
  );
}
