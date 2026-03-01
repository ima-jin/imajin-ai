'use client';

import Link from 'next/link';

interface EventWithStats {
  id: string;
  title: string;
  startsAt: Date;
  imageUrl: string | null;
  status: string;
  statusBadge: string;
  ticketsSold: number;
  revenue: number;
}

interface Props {
  event: EventWithStats;
}

const statusColors = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  live: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  paused: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  past: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const statusLabels = {
  draft: 'Draft',
  live: 'Live',
  paused: 'Paused',
  past: 'Past',
  published: 'Live',
  cancelled: 'Cancelled',
  completed: 'Past',
};

export function EventCard({ event }: Props) {
  const eventDate = new Date(event.startsAt);
  const formattedDate = eventDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const formattedTime = eventDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  const status = event.statusBadge || event.status;
  const statusColor = statusColors[status as keyof typeof statusColors] || statusColors.draft;
  const statusLabel = statusLabels[status as keyof typeof statusLabels] || status;

  return (
    <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden hover:shadow-xl transition-shadow group">
      {/* Image */}
      <Link href={`/${event.id}`} className="block">
        <div className="relative h-48 bg-gradient-to-br from-orange-500 to-amber-600 overflow-hidden">
          {event.imageUrl ? (
            <img
              src={event.imageUrl}
              alt={event.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-6xl">🎉</span>
            </div>
          )}
          {/* Status badge */}
          <div className="absolute top-3 right-3">
            <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase ${statusColor}`}>
              {statusLabel}
            </span>
          </div>
        </div>
      </Link>

      {/* Content */}
      <div className="p-5">
        <Link href={`/${event.id}`} className="block mb-3">
          <h3 className="text-xl font-bold group-hover:text-orange-500 transition-colors line-clamp-2">
            {event.title}
          </h3>
        </Link>

        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 mb-4">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>{formattedDate} at {formattedTime}</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Tickets Sold</div>
            <div className="text-2xl font-bold">{event.ticketsSold}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Revenue</div>
            <div className="text-2xl font-bold">
              ${(event.revenue / 100).toFixed(0)}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 flex gap-2">
          <Link
            href={`/${event.id}/edit`}
            className="flex-1 text-center px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 font-medium rounded-lg transition-colors"
          >
            Edit
          </Link>
          <Link
            href={`/${event.id}`}
            className="flex-1 text-center px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
          >
            View
          </Link>
        </div>
      </div>
    </div>
  );
}
