import Link from 'next/link';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import IdentityOwnershipPanel from '@/app/auth/components/IdentityOwnershipPanel';

export const dynamic = 'force-dynamic';

export default async function OwnershipPage({
  params,
}: Readonly<{ params: Promise<{ groupDid: string }> }>) {
  const { groupDid: routeDid } = await params;
  const groupDid = decodeURIComponent(routeDid);
  const { sessionDid } = await getEffectiveDid();
  if (!sessionDid) {
    const returnPath = `/auth/groups/${encodeURIComponent(groupDid)}/ownership`;
    return (
      <div className="space-y-4 p-6 text-zinc-300">
        <h1 className="text-xl font-mono text-white">Ownership invitation</h1>
        <p>Sign in as the named recipient to review and accept this transfer.</p>
        <Link className="text-amber-400 underline" href={`/auth/login?next=${encodeURIComponent(returnPath)}`}>Sign in to review</Link>
      </div>
    );
  }
  return <IdentityOwnershipPanel groupDid={groupDid} />;
}
