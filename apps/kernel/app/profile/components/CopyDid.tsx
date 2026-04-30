'use client';

interface CopyDidProps {
  did: string;
}

export function CopyDid({ did }: CopyDidProps) {
  return (
    <button
      onClick={() => navigator.clipboard.writeText(did)}
      className="text-xs text-gray-600 hover:text-gray-400 transition font-mono"
    >
      {did.slice(0, 20)}… 📋
    </button>
  );
}
