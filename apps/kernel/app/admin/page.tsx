import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';

const sql = getClient();

interface StatCard {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: string;
}

function StatCardUI({ label, value, subtitle, icon }: StatCard) {
  return (
    <div className="bg-white dark:bg-surface-elevated p-6 border border-gray-100 dark:border-white/10">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-secondary dark:text-secondary">{label}</p>
          <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-primary truncate">
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-secondary dark:text-secondary truncate">{subtitle}</p>
          )}
        </div>
        <span className="text-2xl ml-3">{icon}</span>
      </div>
    </div>
  );
}

export default async function AdminOverviewPage() {
  // --- Stats queries ---
  const [identityCountRow] = await sql`
    SELECT COUNT(*) AS total FROM auth.identities
  `;

  const tierRows = await sql`
    SELECT tier, COUNT(*) AS count
    FROM auth.identities
    GROUP BY tier
  `;

  const tierMap: Record<string, number> = {};
  for (const row of tierRows) {
    tierMap[row.tier as string] = Number(row.count);
  }

  const tierSubtitle = [
    tierMap['soft'] ? `${tierMap['soft']} soft` : null,
    tierMap['preliminary'] ? `${tierMap['preliminary']} preliminary` : null,
    tierMap['established'] ? `${tierMap['established']} established` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const [sessionCountRow] = await sql`
    SELECT COUNT(*) AS total
    FROM auth.attestations
    WHERE type = 'session.created'
    AND issued_at > NOW() - INTERVAL '24 hours'
  `;

  const [subscriberCountRow] = await sql`
    SELECT COUNT(*) AS total
    FROM www.contacts
    WHERE is_verified = true
  `;

  // --- Recent attestations ---
  const recentAttestations = await sql`
    SELECT id, type, subject_did, issued_at
    FROM auth.attestations
    ORDER BY issued_at DESC
    LIMIT 10
  `;

  const stats: StatCard[] = [
    {
      label: 'Total Identities',
      value: Number(identityCountRow?.total ?? 0).toLocaleString(),
      subtitle: tierSubtitle || undefined,
      icon: '🪪',
    },
    {
      label: 'Active Sessions (24h)',
      value: Number(sessionCountRow?.total ?? 0).toLocaleString(),
      icon: '🔑',
    },
    {
      label: 'Subscribers',
      value: Number(subscriberCountRow?.total ?? 0).toLocaleString(),
      subtitle: 'verified emails',
      icon: '📬',
    },
    {
      label: 'Services',
      value: '15',
      subtitle: '9 kernel · 6 userspace',
      icon: '⚙️',
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Overview</h1>
        <p className="mt-1 text-sm text-secondary dark:text-secondary">
          Node health and activity at a glance
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        {stats.map((stat) => (
          <StatCardUI key={stat.label} {...stat} />
        ))}
      </div>

      {/* Recent attestations */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-primary mb-4 font-mono">
          Recent Attestations
        </h2>
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
          {recentAttestations.length === 0 ? (
            <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">
              No attestations yet
            </p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-white/10">
              {recentAttestations.map((att) => {
                const subjectDid = att.subject_did as string;
                const shortDid = `${subjectDid.slice(0, 18)}…${subjectDid.slice(-6)}`;
                const issuedAt = att.issued_at as Date;
                const relativeTime = issuedAt
                  ? formatDistanceToNow(new Date(issuedAt), { addSuffix: true })
                  : '—';

                return (
                  <div
                    key={att.id as string}
                    className="flex items-center justify-between px-6 py-3 hover:bg-gray-50 dark:hover:bg-surface-elevated/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="inline-block text-xs bg-gray-100 dark:bg-surface-elevated text-gray-700 dark:text-primary px-2 py-0.5 font-mono mr-3">
                        {att.type as string}
                      </span>
                      <span className="text-xs text-secondary dark:text-secondary font-mono">
                        {shortDid}
                      </span>
                    </div>
                    <span className="text-xs text-secondary dark:text-secondary ml-4 whitespace-nowrap">
                      {relativeTime}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
