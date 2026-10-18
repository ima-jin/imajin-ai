import { db, identities, identityMembers } from '@/src/db';
import { and, eq, isNull } from 'drizzle-orm';
import Link from 'next/link';

export default async function IdentityOwner({ groupDid }: Readonly<{ groupDid: string }>) {
  const [owner] = await db.select({
    did: identityMembers.memberDid,
    name: identities.name,
    handle: identities.handle,
  }).from(identityMembers)
    .leftJoin(identities, eq(identities.id, identityMembers.memberDid))
    .where(and(
      eq(identityMembers.identityDid, groupDid),
      eq(identityMembers.role, 'owner'),
      isNull(identityMembers.removedAt),
    )).limit(1);
  if (!owner) return null;
  return (
    <div className="text-sm text-zinc-400 space-y-1">
      <p>Owner: <span className="text-zinc-200">{owner.name || owner.handle || owner.did}</span></p>
      <p className="font-mono text-xs break-all">{owner.did}</p>
      <Link className="text-amber-400 underline" href={`/auth/groups/${encodeURIComponent(groupDid)}/ownership`}>Manage ownership</Link>
    </div>
  );
}
