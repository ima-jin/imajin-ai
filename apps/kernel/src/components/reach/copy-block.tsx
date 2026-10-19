'use client';

import { useState } from 'react';

/** Public instructions only. Never accepts, requests, or persists credentials. */
export function CopyBlock({ label, text }: Readonly<{ label: string; text: string }>) {
  const [status, setStatus] = useState('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus('Copy unavailable. Select and copy the text below.');
    }
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-black/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="min-h-10 rounded-lg px-3 text-sm font-medium text-orange-700 hover:bg-orange-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 dark:text-orange-400 dark:hover:bg-orange-950"
        >
          Copy
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-relaxed [overflow-wrap:anywhere] sm:text-sm"><code>{text}</code></pre>
      <p role="status" aria-live="polite" className="px-4 pb-2 text-xs text-gray-600 dark:text-gray-400">{status}</p>
    </div>
  );
}
