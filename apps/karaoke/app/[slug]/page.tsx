'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ParticipantRow } from '@/components/ParticipantRow';
import { SignupForm } from '@/components/SignupForm';
import type { Event, Participant } from '@/db';

interface EventWithParticipants extends Event {
  participants: Participant[];
}

export default function EventPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [event, setEvent] = useState<EventWithParticipants | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null!);

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

  const scrollToSignup = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    <main className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <header className="p-4 bg-gray-800 border-b border-gray-700">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">🎤 {event.name}</h1>
              {event.location && (
                <p className="text-gray-400 text-sm">📍 {event.location}</p>
              )}
            </div>
            <button
              onClick={scrollToSignup}
              className="px-4 py-2 bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-600 transition-colors"
            >
              + Sign Up
            </button>
          </div>
        </div>
      </header>

      {/* Queue */}
      <div className="flex-1 max-w-2xl mx-auto w-full">
        {waitingParticipants.length === 0 && doneParticipants.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No one in the queue yet. Be the first to sign up!
          </div>
        ) : (
          <>
            {/* Waiting queue */}
            {waitingParticipants.map((p, i) => (
              <ParticipantRow key={p.id} participant={p} position={i + 1} />
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

      {/* Signup form at bottom */}
      <div className="sticky bottom-0 max-w-2xl mx-auto w-full">
        <SignupForm eventSlug={slug} onSignup={fetchEvent} formRef={formRef} />
      </div>
    </main>
  );
}
