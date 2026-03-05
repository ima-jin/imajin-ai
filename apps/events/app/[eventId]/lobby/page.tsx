'use client';

import Link from 'next/link';
import { EventChat } from '../components/EventChat';

export default function EventLobbyPage({ params }: { params: { eventId: string } }) {
  const { eventId } = params;

  return (
    <div className="max-w-4xl mx-auto flex flex-col h-[calc(100vh-120px)]">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b border-gray-200 dark:border-gray-700 mb-4">
        <Link
          href={`/${eventId}`}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
        >
          {'\u2190'} Back to Event
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Event Lobby</h1>
          <p className="text-sm text-gray-500">Connect with other ticket holders</p>
        </div>
      </div>

      <EventChat eventId={eventId} />
    </div>
  );
}
