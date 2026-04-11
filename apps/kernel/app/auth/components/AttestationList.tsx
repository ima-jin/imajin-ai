import { db, identities, attestations } from '@/src/db';
import { eq, or, and, isNull, desc, inArray } from 'drizzle-orm';
import Link from 'next/link';

const TYPE_BADGE: Record<string, { label: string; classes: string }> = {
  'session.created': {
    label: 'session',
    classes: 'bg-blue-900/30 text-blue-400 border-blue-800',
  },
  vouch: {
    label: 'vouch',
    classes: 'bg-purple-900/30 text-purple-400 border-purple-800',
  },
  'connection.invited': {
    label: 'invited',
    classes: 'bg-cyan-900/30 text-cyan-400 border-cyan-800',
  },
  'connection.accepted': {
    label: 'connected',
    classes: 'bg-teal-900/30 text-teal-400 border-teal-800',
  },
  'transaction.settled': {
    label: 'payment',
    classes: 'bg-green-900/30 text-green-400 border-green-800',
  },
  customer: {
    label: 'customer',
    classes: 'bg-amber-900/30 text-amber-400 border-amber-800',
  },
};

const ALL_TYPES = Object.keys(TYPE_BADGE);

function getBadge(type: string) {
  return (
    TYPE_BADGE[type] ?? { label: type, classes: 'bg-zinc-800 text-zinc-400 border-zinc-700' }
  );
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function resolvedName(
  did: string,
  identity: { handle?: string | null; name?: string | null } | undefined,
): string {
  if (identity?.handle) return `@${identity.handle}`;
  if (identity?.name) return identity.name;
  return did.slice(0, 22) + '…';
}

const PAGE_SIZE = 20;

interface Props {
  sessionDid: string;
  searchParams: { type?: string; role?: string; page?: string };
}

export default async function AttestationList({ sessionDid, searchParams }: Props) {
  const { type: typeFilter, role = 'all' } = searchParams;
  const page = Math.max(1, parseInt(searchParams.page || '1'));
  const offset = (page - 1) * PAGE_SIZE;

  // Build role condition
  const issuedByMe = eq(attestations.issuerDid, sessionDid);
  const aboutMe = eq(attestations.subjectDid, sessionDid);
  const roleCondition =
    role === 'issued' ? issuedByMe : role === 'subject' ? aboutMe : or(issuedByMe, aboutMe)!;

  const conditions = [roleCondition, isNull(attestations.revokedAt)];
  if (typeFilter) conditions.push(eq(attestations.type, typeFilter));

  const rows = await db
    .select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(desc(attestations.issuedAt))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // Batch-resolve all DIDs to display names
  const allDids = [...new Set([sessionDid, ...items.map((r) => r.issuerDid), ...items.map((r) => r.subjectDid)])];
  const identityRows =
    allDids.length > 0
      ? await db
          .select({ id: identities.id, handle: identities.handle, name: identities.name })
          .from(identities)
          .where(inArray(identities.id, allDids))
      : [];
  const identityMap = new Map(identityRows.map((i) => [i.id, i]));

  const filterParams: Record<string, string> = {};
  if (typeFilter) filterParams.type = typeFilter;
  if (role !== 'all') filterParams.role = role;
  const hasFilters = !!typeFilter || role !== 'all';

  return (
    <div className="space-y-4">
      {/* Header */}
      <h2 className="text-xl font-bold text-white">Attestations</h2>

      {/* Filter bar */}
      <form
        method="GET"
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-wrap gap-3 items-end"
      >
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs text-zinc-500 mb-1.5">Role</label>
          <select
            name="role"
            defaultValue={role}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
          >
            <option value="all">All (issued or about me)</option>
            <option value="issued">Issued by me</option>
            <option value="subject">About me</option>
          </select>
        </div>

        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs text-zinc-500 mb-1.5">Type</label>
          <select
            name="type"
            defaultValue={typeFilter || ''}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
          >
            <option value="">All types</option>
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
          >
            Filter
          </button>
          {hasFilters && (
            <Link
              href="/auth"
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg transition-colors"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {/* Attestation list */}
      {items.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
          No attestations found
          {hasFilters && (
            <div className="mt-2">
              <Link href="/auth" className="text-amber-500 hover:text-amber-400 text-sm">
                Clear filters
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {items.map((att) => {
            const badge = getBadge(att.type);
            const issuer = identityMap.get(att.issuerDid);
            const subject = identityMap.get(att.subjectDid);
            const isIssuer = att.issuerDid === sessionDid;
            const isSubject = att.subjectDid === sessionDid;
            const absoluteTime = att.issuedAt.toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            const relTime = relativeTime(att.issuedAt);

            const signedPayload = {
              id: att.id,
              issuer_did: att.issuerDid,
              subject_did: att.subjectDid,
              type: att.type,
              context_id: att.contextId,
              context_type: att.contextType,
              payload: att.payload,
              signature: att.signature,
              issued_at: att.issuedAt,
            };

            return (
              <details key={att.id} className="group">
                <summary className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-zinc-800/40 transition-colors [list-style:none] [&::-webkit-details-marker]:hidden">
                  {/* Type badge */}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${badge.classes}`}
                  >
                    {badge.label}
                  </span>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap text-sm">
                      <span className={`font-medium ${isIssuer ? 'text-amber-400' : 'text-zinc-300'}`}>
                        {resolvedName(att.issuerDid, issuer)}
                      </span>
                      <span className="text-zinc-600">→</span>
                      <span className={`font-medium ${isSubject ? 'text-amber-400' : 'text-zinc-300'}`}>
                        {resolvedName(att.subjectDid, subject)}
                      </span>
                    </div>
                    {att.contextId && (
                      <div className="text-xs text-zinc-600 mt-0.5 font-mono truncate">
                        {att.contextId}
                      </div>
                    )}
                  </div>

                  {/* Time + chevron */}
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-zinc-500" title={absoluteTime}>
                      {relTime}
                    </span>
                    <svg
                      className="w-4 h-4 text-zinc-600 transition-transform group-open:rotate-180"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </summary>

                {/* Expanded: full signed payload */}
                <div className="px-5 pb-5 border-t border-zinc-800/60 space-y-3">
                  <div className="pt-3 space-y-1 text-xs">
                    <div className="flex gap-2">
                      <span className="text-zinc-600 w-14 shrink-0">Issuer</span>
                      <span className="font-mono text-zinc-400 break-all">
                        {issuer?.handle && (
                          <span className="text-zinc-300 mr-1">@{issuer.handle}</span>
                        )}
                        {!issuer?.handle && issuer?.name && (
                          <span className="text-zinc-300 mr-1">{issuer.name}</span>
                        )}
                        <span className="text-zinc-600">{att.issuerDid}</span>
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-zinc-600 w-14 shrink-0">Subject</span>
                      <span className="font-mono text-zinc-400 break-all">
                        {subject?.handle && (
                          <span className="text-zinc-300 mr-1">@{subject.handle}</span>
                        )}
                        {!subject?.handle && subject?.name && (
                          <span className="text-zinc-300 mr-1">{subject.name}</span>
                        )}
                        <span className="text-zinc-600">{att.subjectDid}</span>
                      </span>
                    </div>
                    {att.expiresAt && (
                      <div className="flex gap-2">
                        <span className="text-zinc-600 w-14 shrink-0">Expires</span>
                        <span className="text-zinc-500">
                          {att.expiresAt.toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-xs font-medium text-zinc-400 mb-2">Signed payload</div>
                    <pre className="text-xs font-mono bg-black/40 border border-zinc-800 rounded-lg p-3 text-zinc-500 overflow-auto whitespace-pre-wrap">
                      {JSON.stringify(signedPayload, null, 2)}
                    </pre>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {(page > 1 || hasMore) && (
        <div className="flex justify-between items-center">
          {page > 1 ? (
            <Link
              href={`/auth?${new URLSearchParams({ ...filterParams, page: String(page - 1) })}`}
              className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
            >
              ← Previous
            </Link>
          ) : (
            <div />
          )}
          {hasMore && (
            <Link
              href={`/auth?${new URLSearchParams({ ...filterParams, page: String(page + 1) })}`}
              className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
