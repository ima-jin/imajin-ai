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
      className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors"
    >
      🐛 Report a Bug
    </button>
  );
}
