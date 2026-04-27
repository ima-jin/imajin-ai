'use client';

import { useState, useEffect } from 'react';

interface UpcomingEventsProps {
  did: string;
  eventsBaseUrl?: string;
  viewerDid?: string | null;
}

interface AttendingEvent {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string | null;
  venue: string | null;
  imageUrl: string | null;
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

export function UpcomingEvents({ did, eventsBaseUrl, viewerDid }: UpcomingEventsProps) {
  const [events, setEvents] = useState<AttendingEvent[] | null>(null);

  const eventsBase = eventsBaseUrl || process.env.NEXT_PUBLIC_EVENTS_URL || '/events';

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
      <h2 className="text-sm font-semibold text-primary mb-2 font-mono">📅 Upcoming Events</h2>
      <ul className="space-y-2">
        {events.map((event) => (
          <li key={event.eventId}>
            <a
              href={`${eventsBase}/${event.eventId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-2 bg-surface-surface border border-white/10 hover:border-white/10 transition"
            >
              {event.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={event.imageUrl.startsWith('/') ? `${eventsBase}${event.imageUrl}` : event.imageUrl}
                  alt={event.title}
                  className="w-10 h-10 object-cover shrink-0"
                />
              ) : (
                <div className="w-10 h-10 bg-surface-elevated flex items-center justify-center shrink-0 text-lg">
                  📅
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm text-primary font-medium truncate">{event.title}</p>
                <p className="text-xs text-secondary mt-0.5">
                  {formatEventDate(event.startDate, event.endDate)}
                  {event.venue && <span className="text-secondary"> · {event.venue}</span>}
                </p>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
