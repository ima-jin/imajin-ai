'use client';

import { useToast } from '@imajin/ui';

export function BugReporterOpenButton() {
  const { toast } = useToast();

  const handleClick = () => {
    const btn = document.querySelector('[data-bug-reporter-trigger]') as HTMLElement | null;
    if (btn) {
      btn.click();
    } else {
      toast.warning('Bug reporter is loading — try again in a moment.');
    }
  };

  return (
    <button
      onClick={handleClick}
      style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="px-4 py-2 hover:brightness-110 text-primary text-sm font-medium transition-colors"
    >
      🐛 Report a Bug
    </button>
  );
}
