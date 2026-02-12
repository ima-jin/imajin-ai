'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ParticipantRow } from '@/components/ParticipantRow';
import { EventForm } from '@/components/EventForm';
import type { Event, Participant } from '@/db';

interface EventWithParticipants extends Event {
  participants: Participant[];
}

export default function AdminPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [event, setEvent] = useState<EventWithParticipants | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showEditForm, setShowEditForm] = useState(false);

  const fetchEvent = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${slug}`);
      if (res.ok) {
        const data = await res.json();
        setEvent(data);
      } else if (res.status === 404) {
        setError('Event not found');
      }
    } catch (err) {
      console.error('Failed to fetch event:', err);
      setError('Failed to load event');
    } finally {
      setIsLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchEvent();
    // Poll for updates every 3 seconds
    const interval = setInterval(fetchEvent, 3000);
    return () => clearInterval(interval);
  }, [fetchEvent]);

  const handleStatusChange = async (participantId: string, status: string) => {
    try {
      const res = await fetch(`/api/events/${slug}/participants/${participantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (res.ok) {
        fetchEvent(); // Refresh the list
      }
    } catch (err) {
      console.error('Failed to update participant:', err);
    }
  };

  const handleEditEvent = async (data: {
    name: string;
    location?: string;
    startTime: string;
    endTime?: string;
  }) => {
    const res = await fetch(`/api/events/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to update event');
    }

    setShowEditForm(false);
    fetchEvent();
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </main>
    );
  }

  if (error || !event) {
    return (
      <main className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center">
        <p className="text-red-400 mb-4">{error || 'Event not found'}</p>
        <Link href="/" className="text-orange-500 hover:text-orange-400">
          ← Back to events
        </Link>
      </main>
    );
  }

  const waitingParticipants = event.participants.filter(
    (p) => p.status === 'waiting' || p.status === 'active'
  );
  const doneParticipants = event.participants.filter(
    (p) => p.status === 'complete' || p.status === 'skipped'
  );

  return (
    <main className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="p-4 bg-gray-800 border-b border-gray-700">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <Link href={`/${slug}`} className="text-gray-400 hover:text-white">
                ←
              </Link>
              <h1 className="text-xl font-bold">🎤 {event.name}</h1>
              <span className="px-2 py-1 bg-orange-500/20 text-orange-400 text-xs rounded">
                ADMIN
              </span>
            </div>
            <button
              onClick={() => setShowEditForm(true)}
              className="px-3 py-1 bg-gray-700 text-white text-sm rounded hover:bg-gray-600 transition-colors"
            >
              Edit Event
            </button>
          </div>
          {event.location && (
            <p className="text-gray-400 text-sm ml-8">📍 {event.location}</p>
          )}
        </div>
      </header>

      {/* Edit form modal */}
      {showEditForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold mb-4">Edit Event</h2>
            <EventForm
              event={event}
              onSubmit={handleEditEvent}
              onCancel={() => setShowEditForm(false)}
            />
          </div>
        </div>
      )}

      {/* Queue with controls */}
      <div className="max-w-2xl mx-auto">
        <div className="p-4 bg-gray-800/50 border-b border-gray-700">
          <p className="text-gray-400 text-sm">
            {waitingParticipants.length} waiting • {doneParticipants.length} completed
          </p>
        </div>

        {waitingParticipants.length === 0 && doneParticipants.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No one in the queue yet.
          </div>
        ) : (
          <>
            {/* Waiting queue with controls */}
            {waitingParticipants.map((p, i) => (
              <ParticipantRow
                key={p.id}
                participant={p}
                position={i + 1}
                showControls
                onStatusChange={handleStatusChange}
              />
            ))}

            {/* Completed section */}
            {doneParticipants.length > 0 && (
              <>
                <div className="px-4 py-2 bg-gray-800 text-gray-500 text-sm uppercase tracking-wide">
                  Completed ({doneParticipants.length})
                </div>
                {doneParticipants.map((p, i) => (
                  <ParticipantRow
                    key={p.id}
                    participant={p}
                    position={waitingParticipants.length + i + 1}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
