'use client';

export interface PersonalInboxAttention {
  pending: number;
  handle: string | null;
}

/** No personal card contents are loaded until the session returns to itself. */
export function PersonalApprovalsNotice({ attention, busy, onSwitch }: Readonly<{
  attention: PersonalInboxAttention;
  busy: boolean;
  onSwitch: () => void;
}>) {
  if (attention.pending <= 0) return null;
  return (
    <output className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-3 border border-amber-800/60 bg-amber-950/40 p-3 text-sm text-amber-300">
      <span className="min-w-0 break-words">
        {attention.pending} {attention.pending === 1 ? 'approval' : 'approvals'} waiting for you as{' '}
        <span className="font-mono">{attention.handle ? `@${attention.handle}` : 'your personal identity'}</span>.
      </span>
      <button type="button" disabled={busy} onClick={onSwitch}
        className="min-h-11 shrink-0 border border-amber-500/50 px-3 py-2 font-mono text-sm hover:bg-amber-500/20 disabled:opacity-40">
        {busy ? 'Switching…' : 'Switch back'}
      </button>
    </output>
  );
}
