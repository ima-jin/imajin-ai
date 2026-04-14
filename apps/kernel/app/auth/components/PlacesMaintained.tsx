import { db, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import Link from 'next/link';

interface Props {
  sessionDid: string;
}

interface PlaceRow {
  did: string;
  name: string;
  handle: string | null;
  claimStatus: string | null;
  metadata: { category?: string } | null;
}

export default async function PlacesMaintained({ sessionDid }: Props) {
  let rows: PlaceRow[] = [];

  try {
    rows = (await db
      .select({
        did: identityMembers.identityDid,
        name: profiles.displayName,
        handle: profiles.handle,
        claimStatus: profiles.claimStatus,
        metadata: profiles.metadata,
      })
      .from(identityMembers)
      .innerJoin(profiles, eq(profiles.did, identityMembers.identityDid))
      .where(
        and(
          eq(identityMembers.memberDid, sessionDid),
          eq(identityMembers.role, 'maintainer'),
          isNull(identityMembers.removedAt)
        )
      )) as PlaceRow[];
  } catch {
    return null;
  }

  return (
    <div className="mt-4 border-t border-gray-800 pt-4">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1">
        Places I Maintain
      </h2>

      {rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-600">No places yet.</p>
      ) : (
        <div className="space-y-0.5">
          {rows.map((row) => (
            <Link
              key={row.did}
              href={`/auth/stubs/${row.did}`}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-800/60 transition-colors no-underline"
            >
              <span className="text-lg leading-none">🏢</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{row.name}</div>
                {(row.handle || row.metadata?.category) && (
                  <div className="text-xs text-zinc-500 truncate">
                    {row.handle ? `@${row.handle}` : ''}
                    {row.handle && row.metadata?.category ? ' · ' : ''}
                    {row.metadata?.category ?? ''}
                  </div>
                )}
              </div>
              {row.claimStatus === 'unclaimed' && (
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-900/30 border border-amber-700/50 rounded text-amber-400 shrink-0">
                  unclaimed
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-2">
        <Link
          href="/auth/stubs/new"
          className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg no-underline"
        >
          <span className="text-base leading-none">+</span> Add a Place
        </Link>
      </div>
    </div>
  );
}
