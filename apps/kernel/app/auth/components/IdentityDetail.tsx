import { db, identities, attestations, connections, identityMembers, profiles } from '@/src/db';
import { eq, or, and, isNull, count } from 'drizzle-orm';
import Link from 'next/link';

function tierBadge(tier: string): { label: string; classes: string } {
  if (tier === 'established') return { label: 'established', classes: 'bg-success/30 text-success border-green-800' };
  if (tier === 'preliminary') return { label: 'preliminary', classes: 'bg-blue-900/30 text-blue-400 border-blue-800' };
  return { label: 'soft', classes: 'bg-surface-elevated text-secondary border-white/10' };
}

interface Props {
  did: string;
  sessionDid: string;
}

export default async function IdentityDetail({ did, sessionDid }: Props) {
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

  // Determine edit href based on scope and membership role
  let editHref: string | null = null;
  if (identity.scope === 'actor') {
    // If viewing own profile, no param needed. If acting-as, pass the DID.
    editHref = did === sessionDid ? '/profile/edit' : `/profile/edit?did=${encodeURIComponent(did)}`;
  } else {
    const [[membership], [profile]] = await Promise.all([
      db
        .select({ role: identityMembers.role })
        .from(identityMembers)
        .where(
          and(
            eq(identityMembers.identityDid, did),
            eq(identityMembers.memberDid, sessionDid),
            isNull(identityMembers.removedAt)
          )
        )
        .limit(1),
      db
        .select({ claimedBy: profiles.claimedBy })
        .from(profiles)
        .where(eq(profiles.did, did))
        .limit(1),
    ]);

    if (membership?.role === 'maintainer' || profile?.claimedBy === null) {
      editHref = `/auth/stubs/${did}`;
    } else if (membership?.role === 'owner' || membership?.role === 'admin') {
      editHref = `/auth/groups/${did}/settings`;
    }
  }

  return (
    <div className="bg-surface-base border border-white/10 p-6 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-primary font-mono">
            {displayName ?? did.slice(0, 32) + '…'}
          </h2>
          {identity.handle && (
            <p className="text-secondary text-sm mt-0.5">@{identity.handle}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2 py-1 border ${badge.classes}`}>
            {badge.label}
          </span>
          {editHref && (
            <Link
              href={editHref}
              className="text-xs px-2 py-1 border border-white/10 text-secondary hover:text-primary hover:border-white/30 transition-colors"
            >
              Edit
            </Link>
          )}
        </div>
      </div>

      <div className="font-mono text-xs text-muted break-all">{did}</div>

      <div className="flex flex-wrap gap-4 text-sm text-secondary pt-1">
        <span>
          <span className="text-primary font-medium">{connCount}</span>{' '}
          {connCount === 1 ? 'connection' : 'connections'}
        </span>
        <span>
          <span className="text-primary font-medium">{attCount}</span>{' '}
          {attCount === 1 ? 'attestation' : 'attestations'}
        </span>
        <span className="text-muted capitalize">{identity.scope}{identity.subtype ? `/${identity.subtype}` : ''}</span>
      </div>

      {identity.createdAt && (
        <div className="text-xs text-muted">
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
