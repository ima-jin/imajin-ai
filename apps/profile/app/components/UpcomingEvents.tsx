'use client';

import { useState, useEffect } from 'react';

interface UpcomingEventsProps {
  did: string;
  servicePrefix: string;
  domain: string;
  viewerDid?: string | null;
}

interface AttendingEvent {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string | null;
  venue: string | null;
}

function formatEventDate(startDate: string, endDate: string | null): string {
  const start = new Date(startDate);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  const startStr = start.toLocaleDateString('en-US', opts);

  if (!endDate) return startStr;

  const end = new Date(endDate);
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  ) {
    return startStr;
  }

  return `${startStr} – ${end.toLocaleDateString('en-US', opts)}`;
}

export function UpcomingEvents({ did, servicePrefix, domain, viewerDid }: UpcomingEventsProps) {
  const [events, setEvents] = useState<AttendingEvent[] | null>(null);

  const eventsBase = `${servicePrefix}events.${domain}`;

  useEffect(() => {
    const url = new URL(`${eventsBase}/api/attending/${encodeURIComponent(did)}`);
    if (viewerDid) url.searchParams.set('viewer_did', viewerDid);

    fetch(url.toString())
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setEvents(Array.isArray(data) ? data : []))
      .catch(() => setEvents([]));
  }, [did, eventsBase, viewerDid]);

  if (!events || events.length === 0) return null;

  return (
    <div className="mt-6 text-left">
      <h2 className="text-sm font-semibold text-gray-300 mb-2">📅 Upcoming Events</h2>
      <ul className="space-y-2">
        {events.map((event) => (
          <li key={event.eventId}>
            <a
              href={`${eventsBase}/${event.eventId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700 transition"
            >
              <p className="text-sm text-white font-medium truncate">{event.title}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {formatEventDate(event.startDate, event.endDate)}
                {event.venue && <span className="text-gray-500"> · {event.venue}</span>}
              </p>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
