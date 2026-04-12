'use client';

import { useIdentities } from '@imajin/ui';

function scopeIcon(scope: string): string {
  if (scope === 'community') return '🌐';
  if (scope === 'business') return '🏢';
  if (scope === 'family') return '👨‍👩‍👦';
  return '👤';
}

interface Props {
  authUrl: string;
  profileUrl: string;
  personalDid: string;
  personalName: string | null;
  personalHandle: string | null;
}

export default function IdentitySwitcher({
  authUrl,
  profileUrl,
  personalDid,
  personalName,
  personalHandle,
}: Props) {
  const { identities, loading, activeIdentity } = useIdentities(authUrl, profileUrl);

  async function switchTo(did: string | null) {
    try {
      const res = await fetch('/auth/api/session/act-as', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ did }),
      });
      if (res.ok) {
        // Sync localStorage + client-side cookie
        if (did) {
          localStorage.setItem('imajin:acting-as', did);
          document.cookie = `x-acting-as=${did}; path=/; max-age=31536000; SameSite=Lax`;
        } else {
          localStorage.removeItem('imajin:acting-as');
          document.cookie = 'x-acting-as=; path=/; max-age=0';
        }
        window.location.reload();
      }
    } catch {
      // ignore network errors
    }
  }

  const isPersonal = !activeIdentity;
  const personalLabel = personalName || (personalHandle ? `@${personalHandle}` : 'Personal');

  return (
    <div className="space-y-0.5">
      {/* Personal identity */}
      <button
        onClick={() => switchTo(null)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
          isPersonal
            ? 'border-l-2 border-amber-500 bg-amber-500/10 pl-2.5'
            : 'hover:bg-zinc-800/60'
        }`}
      >
        <span className="text-lg leading-none">👤</span>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium truncate ${isPersonal ? 'text-amber-400' : 'text-white'}`}>
            {personalLabel}
          </div>
          {personalHandle && (
            <div className="text-xs text-zinc-500 truncate">@{personalHandle}</div>
          )}
        </div>
        {isPersonal && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
      </button>

      {/* Group identities */}
      {loading && (
        <div className="px-3 py-2 text-xs text-zinc-600">Loading…</div>
      )}
      {identities.map((identity) => {
        const isActive = activeIdentity === identity.groupDid;
        const label = identity.name || (identity.handle ? `@${identity.handle}` : identity.groupDid.slice(0, 16) + '…');
        return (
          <button
            key={identity.groupDid}
            onClick={() => switchTo(identity.groupDid)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
              isActive
                ? 'border-l-2 border-amber-500 bg-amber-500/10 pl-2.5'
                : 'hover:bg-zinc-800/60'
            }`}
          >
            <span className="text-lg leading-none">{scopeIcon(identity.scope)}</span>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium truncate ${isActive ? 'text-amber-400' : 'text-white'}`}>
                {label}
              </div>
              {identity.handle && (
                <div className="text-xs text-zinc-500 truncate">@{identity.handle}</div>
              )}
            </div>
            {isActive && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
          </button>
        );
      })}

      {/* Divider */}
      <div className="border-t border-gray-800 my-2 pt-1">
        <a
          href="/auth/groups/new?scope=family"
          className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg no-underline"
        >
          <span className="text-base leading-none">+</span> Create Family Identity
        </a>
        <a
          href="/auth/groups/new?scope=community"
          className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg no-underline"
        >
          <span className="text-base leading-none">+</span> Create Community Identity
        </a>
        <a
          href="/auth/groups/new?scope=business"
          className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg no-underline"
        >
          <span className="text-base leading-none">+</span> Create Business Identity
        </a>
      </div>
    </div>
  );
}
