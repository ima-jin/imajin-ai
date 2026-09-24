'use client';

/**
 * Persistent act-as banner for every `/jin` lane (#2359).
 *
 * The second finding behind #2359: the operator could not tell he was in
 * act-as while approving writes. The `x-acting-as` cookie the
 * IdentitySwitcher sets (`app/auth/components/IdentitySwitcher.tsx`) is
 * session-long and silent — nothing on /jin said whose identity the page
 * was wearing. So this renders, above every lane, on every /jin route:
 * who you are, who you're acting as, and one tap to drop it.
 *
 * Rendered from the /jin layout (`layout.tsx`), which resolves both DIDs
 * server-side from the session cookie + `x-acting-as`/`x-acting-for`
 * cookies (`getEffectiveDid`). Renders NOTHING when the acting DID and the
 * session DID are the same — the banner exists to mark the abnormal state,
 * so it must never become chrome the eye learns to skip.
 *
 * Dropping act-as posts `{ did: null }` to `POST /auth/api/session/act-as`
 * — the exact call IdentitySwitcher's "Personal" entry makes — then clears
 * the client-side mirrors of that cookie and reloads, so both the server
 * components and the polling client panels re-resolve under the real
 * session identity.
 */
import { useCallback, useState } from 'react';

/** `did:imajin:abcdef…wxyz` — enough to recognize an identity without wrapping the banner. */
function shortDid(did: string): string {
  return did.length <= 32 ? did : `${did.slice(0, 22)}…${did.slice(-6)}`;
}

/** Returns false when the server refused, so the caller can re-enable the button instead of stranding it mid-drop. */
async function dropActAs(): Promise<boolean> {
  const res = await fetch('/auth/api/session/act-as', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ did: null }),
  });
  if (!res.ok) return false;
  globalThis.localStorage?.removeItem('imajin:acting-as');
  globalThis.document.cookie = 'x-acting-as=; path=/; max-age=0';
  globalThis.location.reload();
  return true;
}

interface ActAsBannerProps {
  /** The real authenticated session DID — the only identity that may countersign on /jin. */
  sessionDid: string | null;
  /** The DID this browsing session is currently attributed to. */
  actingDid: string | null;
}

export function ActAsBanner({ sessionDid, actingDid }: Readonly<ActAsBannerProps>) {
  const [dropping, setDropping] = useState(false);

  const onDrop = useCallback(() => {
    setDropping(true);
    dropActAs()
      .then((dropped) => {
        if (dropped) return;
        setDropping(false);
      })
      .catch(() => setDropping(false));
  }, []);

  if (!sessionDid || !actingDid || sessionDid === actingDid) return null;

  return (
    <div
      data-testid="act-as-banner"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-700/70 bg-amber-950/50 px-6 py-2"
    >
      <p className="text-xs text-amber-200">
        <span className="font-semibold uppercase tracking-wide mr-2">Acting as</span>
        You are signed in as <span className="font-mono text-amber-100">{shortDid(sessionDid)}</span>, acting as{' '}
        <span className="font-mono text-amber-100">{shortDid(actingDid)}</span>. Approvals are self-only — drop act-as to
        decide as yourself.
      </p>
      <button
        type="button"
        onClick={onDrop}
        disabled={dropping}
        className="px-2.5 py-1 rounded text-xs font-medium bg-amber-800/70 text-amber-100 hover:bg-amber-700/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {dropping ? 'Dropping…' : 'Drop act-as'}
      </button>
    </div>
  );
}
