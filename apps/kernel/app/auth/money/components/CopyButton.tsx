'use client';

import { useCallback, useState } from 'react';

interface Props {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}

/** Generic "copy arbitrary text to the clipboard" button — unlike `attestations/components/CopyLinkButton.tsx`, this takes a full URL/string rather than a same-origin relative path (needed for pay-link/invite links, which point outside `/auth`). */
export default function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied ✓', className = '' }: Readonly<Props>) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return;
    clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`px-2.5 py-1 text-xs bg-white/10 hover:bg-white/15 text-white rounded transition shrink-0 ${className}`}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
