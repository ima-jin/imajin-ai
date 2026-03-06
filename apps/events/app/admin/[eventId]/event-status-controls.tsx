'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type EventStatus = 'draft' | 'published' | 'paused' | 'cancelled' | 'completed';

const STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ['published'],
  published: ['paused', 'cancelled', 'completed'],
  paused: ['published', 'cancelled'],
  cancelled: [],
  completed: [],
};

const STATUS_BADGE_STYLES: Record<EventStatus, string> = {
  draft: 'bg-gray-700 text-gray-300 border border-gray-600',
  published: 'bg-green-900/50 text-green-400 border border-green-700',
  paused: 'bg-yellow-900/50 text-yellow-400 border border-yellow-700',
  cancelled: 'bg-red-900/50 text-red-400 border border-red-700',
  completed: 'bg-blue-900/50 text-blue-400 border border-blue-700',
};

const TRANSITION_LABELS: Partial<Record<string, string>> = {
  'draft->published': 'Publish',
  'published->paused': 'Pause',
  'published->cancelled': 'Cancel Event',
  'published->completed': 'Mark Complete',
  'paused->published': 'Resume',
  'paused->cancelled': 'Cancel Event',
};

const TRANSITION_STYLES: Partial<Record<string, string>> = {
  'draft->published': 'bg-green-600 hover:bg-green-700 text-white',
  'published->paused': 'bg-yellow-600 hover:bg-yellow-700 text-white',
  'published->cancelled': 'bg-red-600 hover:bg-red-700 text-white',
  'published->completed': 'bg-blue-600 hover:bg-blue-700 text-white',
  'paused->published': 'bg-green-600 hover:bg-green-700 text-white',
  'paused->cancelled': 'bg-red-600 hover:bg-red-700 text-white',
};

interface Props {
  eventId: string;
  currentStatus: string;
}

export function EventStatusControls({ eventId, currentStatus }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<EventStatus>((currentStatus || 'draft') as EventStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextStatuses = STATUS_TRANSITIONS[status] || [];

  const handleTransition = async (newStatus: EventStatus) => {
    if (newStatus === 'cancelled') {
      const confirmed = window.confirm('Are you sure you want to cancel this event? This cannot be undone.');
      if (!confirmed) return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update status');
      }

      setStatus(newStatus);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow mb-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Event Status</span>
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium capitalize ${STATUS_BADGE_STYLES[status]}`}>
            {status}
          </span>
        </div>

        {nextStatuses.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {nextStatuses.map((next) => {
              const key = `${status}->${next}`;
              return (
                <button
                  key={next}
                  onClick={() => handleTransition(next)}
                  disabled={loading}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${TRANSITION_STYLES[key] || 'bg-gray-600 hover:bg-gray-700 text-white'}`}
                >
                  {loading ? '...' : (TRANSITION_LABELS[key] || next)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
