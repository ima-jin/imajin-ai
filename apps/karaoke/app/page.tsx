'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { EventCard } from '@/components/EventCard';
import { EventForm } from '@/components/EventForm';
import type { Event } from '@/db';

export default function Home() {
  const router = useRouter();
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/events');
      if (res.ok) {
        const data = await res.json();
        setEvents(data);
      }
    } catch (error) {
      console.error('Failed to fetch events:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleCreateEvent = async (data: {
    name: string;
    location?: string;
    startTime: string;
    endTime?: string;
  }) => {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to create event');
    }

    const newEvent = await res.json();
    setShowForm(false);
    router.push(`/${newEvent.slug}`);
  };

  return (
    <main className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-4xl font-bold">
            🎤 <span className="text-orange-500">Karaoke</span>
          </h1>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-600 transition-colors"
          >
            + Add Event
          </button>
        </div>

        {showForm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
            <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
              <h2 className="text-2xl font-bold mb-4">Create Event</h2>
              <EventForm onSubmit={handleCreateEvent} onCancel={() => setShowForm(false)} />
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-center text-gray-500 py-12">Loading events...</div>
        ) : events.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 mb-4">No events yet</p>
            <button
              onClick={() => setShowForm(true)}
              className="text-orange-500 hover:text-orange-400"
            >
              Create your first event →
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
