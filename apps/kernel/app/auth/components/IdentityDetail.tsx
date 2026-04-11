import { db, identities, attestations, connections } from '@/src/db';
import { eq, or, and, isNull, count } from 'drizzle-orm';

function tierBadge(tier: string): { label: string; classes: string } {
  if (tier === 'established') return { label: 'established', classes: 'bg-green-900/30 text-green-400 border-green-800' };
  if (tier === 'preliminary') return { label: 'preliminary', classes: 'bg-blue-900/30 text-blue-400 border-blue-800' };
  return { label: 'soft', classes: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
}

interface Props {
  did: string;
}

export default async function IdentityDetail({ did }: Props) {
  const [identity] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!identity) return null;

  const [{ connCount }] = await db
    .select({ connCount: count() })
    .from(connections)
    .where(
      and(
        or(eq(connections.didA, did), eq(connections.didB, did))!,
        isNull(connections.disconnectedAt)
      )
    );

  const [{ attCount }] = await db
    .select({ attCount: count() })
    .from(attestations)
    .where(
      and(
        or(eq(attestations.issuerDid, did), eq(attestations.subjectDid, did))!,
        isNull(attestations.revokedAt)
      )
    );

  const badge = tierBadge(identity.tier);
  const displayName = identity.name || (identity.handle ? `@${identity.handle}` : null);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">
            {displayName ?? did.slice(0, 32) + '…'}
          </h2>
          {identity.handle && (
            <p className="text-zinc-400 text-sm mt-0.5">@{identity.handle}</p>
          )}
        </div>
        <span className={`text-xs px-2 py-1 rounded-full border shrink-0 ${badge.classes}`}>
          {badge.label}
        </span>
      </div>

      <div className="font-mono text-xs text-zinc-600 break-all">{did}</div>

      <div className="flex flex-wrap gap-4 text-sm text-zinc-400 pt-1">
        <span>
          <span className="text-white font-medium">{connCount}</span>{' '}
          {connCount === 1 ? 'connection' : 'connections'}
        </span>
        <span>
          <span className="text-white font-medium">{attCount}</span>{' '}
          {attCount === 1 ? 'attestation' : 'attestations'}
        </span>
        <span className="text-zinc-600 capitalize">{identity.type}</span>
      </div>

      {identity.createdAt && (
        <div className="text-xs text-zinc-600">
          Created{' '}
          {identity.createdAt.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </div>
      )}
    </div>
  );
}
