'use client';

import Link from 'next/link';
import type { Event } from '@/db';

interface EventCardProps {
  event: Event;
}

export function EventCard({ event }: EventCardProps) {
  const startDate = new Date(event.startTime);
  const isLive = startDate <= new Date();

  return (
    <Link href={`/${event.slug}`}>
      <div className="bg-gray-800 rounded-lg p-4 hover:bg-gray-750 transition-colors border border-gray-700 hover:border-orange-500">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xl font-semibold text-white">{event.name}</h3>
          {isLive && (
            <span className="px-2 py-1 bg-orange-500 text-white text-xs font-bold rounded">
              LIVE
            </span>
          )}
        </div>
        {event.location && (
          <p className="text-gray-400 text-sm mb-2">📍 {event.location}</p>
        )}
        <p className="text-gray-500 text-sm">
          🕐 {startDate.toLocaleDateString()} at{' '}
          {startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </Link>
  );
}
