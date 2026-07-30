'use client';

import { useState, useCallback } from 'react';

interface Props {
  /** Relative path to the document detail/signing page, e.g. /auth/documents/att_123 */
  path: string;
}

export default function CopyLinkButton({ path }: Readonly<Props>) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const origin = globalThis.location?.origin ?? '';
    const url = `${origin}${path}`;
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard) {
      clipboard
        .writeText(url)
        .then(() => {
          setCopied(true);
          globalThis.setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => setCopied(false));
    }
  }, [path]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-xs text-zinc-500 hover:text-amber-400 transition-colors"
    >
      {copied ? 'Link copied ✓' : 'Copy signing link'}
    </button>
  );
}
