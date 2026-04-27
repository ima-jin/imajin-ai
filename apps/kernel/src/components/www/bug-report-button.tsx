'use client';

import { useState } from 'react';
import { BugReportModal } from './bug-report-modal';

export function BugReportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-bug-reporter-trigger
        title="Report a bug"
        aria-label="Report a bug"
        style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full text-primary hover:brightness-110 transition-colors"
      >
        <span className="text-xl" aria-hidden>🐛</span>
      </button>

      {open && <BugReportModal onClose={() => setOpen(false)} />}
    </>
  );
}
