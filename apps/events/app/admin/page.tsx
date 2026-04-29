import { redirect, notFound } from 'next/navigation';
import { requireAdmin } from '@imajin/auth';
import { db, events } from '@/src/db';
import { desc } from 'drizzle-orm';
import Link from 'next/link';

export default async function AdminEventsPage() {
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const allEvents = await db
    .select()
    .from(events)
    .orderBy(desc(events.createdAt));

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Admin — Events</h1>
          <p className="text-gray-600 dark:text-gray-400">
            {allEvents.length} event{allEvents.length !== 1 ? 's' : ''} on the network
          </p>
        </div>
        <a
          href={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/api/admin/events/export.csv`}
          className="inline-flex items-center px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
        >
          ⬇ Export Events
        </a>
      </div>

      {allEvents.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-8 text-center">
          <p className="text-gray-500">No events yet.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Event
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Creator
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  City
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {allEvents.map((event) => (
                <tr key={event.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/${event.id}`}
                      className="text-sm font-medium text-orange-500 hover:text-orange-600"
                    >
                      {event.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={event.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {event.startsAt
                      ? new Date(event.startsAt).toLocaleDateString('en-CA', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono">
                    {event.creatorDid}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {event.city || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const color =
    status === 'published'
      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
      : status === 'draft'
      ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400'
      : status === 'cancelled'
      ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
      : status === 'completed'
      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400'
      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {status || 'unknown'}
    </span>
  );
}
