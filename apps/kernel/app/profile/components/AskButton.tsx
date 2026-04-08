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
        className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-gray-500 text-sm cursor-not-allowed"
      >
        Ask {targetName} <span className="text-gray-600">(coming soon)</span>
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowChat(true)}
        className="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-200 text-sm hover:bg-gray-800 hover:border-gray-600 transition"
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
