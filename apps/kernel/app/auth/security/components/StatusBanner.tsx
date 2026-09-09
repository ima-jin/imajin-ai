'use client';

export interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

/**
 * Transient success/error banner for account security settings (#2119).
 * Purely presentational (S6478 — no props/state captured from module scope).
 */
export default function StatusBanner({ statusMessage }: Readonly<{ statusMessage: StatusMessage | null }>) {
  if (!statusMessage) return null;

  return (
    <div className={`p-4 rounded-lg border ${statusMessage.type === 'success' ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-red-900/20 border-red-800 text-red-400'}`}>
      {statusMessage.text}
    </div>
  );
}
