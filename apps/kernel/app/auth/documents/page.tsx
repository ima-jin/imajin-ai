import { cookies } from 'next/headers';
import { getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import DocumentList from '../attestations/components/DocumentList';

interface SearchParams {
  role?: string;
}

export default async function DocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth');
  }

  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;
  const role = searchParams.role === 'created' ? 'created' : 'needs-signature';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Documents</h2>
        <Link
          href="/auth/attestations?view=documents"
          className="text-sm text-zinc-500 hover:text-amber-400 transition-colors"
        >
          Open in attestations view →
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href="/auth/documents?role=needs-signature"
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            role === 'needs-signature'
              ? 'bg-amber-500/20 border-amber-500 text-amber-300'
              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Needs my signature
        </Link>
        <Link
          href="/auth/documents?role=created"
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            role === 'created'
              ? 'bg-amber-500/20 border-amber-500 text-amber-300'
              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Created by me
        </Link>
      </div>

      <DocumentList sessionDid={effectiveDid} role={role} />
    </div>
  );
}
