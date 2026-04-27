'use client';

import { useState } from 'react';
import { PresenceChat } from './PresenceChat';

interface AskButtonProps {
  targetDid: string;
  targetName: string;
  targetHandle?: string;
  inferenceEnabled: boolean;
  canAsk: boolean;
}

export function AskButton({
  targetDid,
  targetName,
  targetHandle,
  inferenceEnabled,
  canAsk,
}: AskButtonProps) {
  const [showChat, setShowChat] = useState(false);

  if (!inferenceEnabled || !canAsk) {
    return (
      <button
        disabled
        className="px-4 py-2 bg-surface-surface border border-white/10 text-secondary text-sm cursor-not-allowed"
      >
        Ask {targetName} <span className="text-muted">(coming soon)</span>
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowChat(true)}
        className="px-4 py-2 bg-surface-surface border border-white/10 text-primary text-sm hover:bg-surface-elevated hover:border-gray-600 transition"
      >
        Ask {targetName}
      </button>
      {showChat && (
        <PresenceChat
          targetDid={targetDid}
          targetName={targetName}
          targetHandle={targetHandle}
          onClose={() => setShowChat(false)}
        />
      )}
    </>
  );
}
