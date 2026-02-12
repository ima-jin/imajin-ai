'use client';

import { useState } from 'react';
import type { Event } from '@/db';

interface EventFormProps {
  event?: Event;
  onSubmit: (data: { name: string; location?: string; startTime: string; endTime?: string }) => Promise<void>;
  onCancel: () => void;
}

export function EventForm({ event, onSubmit, onCancel }: EventFormProps) {
  const [name, setName] = useState(event?.name || '');
  const [location, setLocation] = useState(event?.location || '');
  const [startTime, setStartTime] = useState(
    event?.startTime
      ? new Date(event.startTime).toISOString().slice(0, 16)
      : ''
  );
  const [endTime, setEndTime] = useState(
    event?.endTime
      ? new Date(event.endTime).toISOString().slice(0, 16)
      : ''
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Event name is required');
      return;
    }
    if (!startTime) {
      setError('Start time is required');
      return;
    }

    const start = new Date(startTime);
    if (!event && start < new Date()) {
      setError('Start time cannot be in the past');
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        location: location.trim() || undefined,
        startTime,
        endTime: endTime || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save event');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 bg-red-500/20 border border-red-500 rounded text-red-400 text-sm">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Event Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Friday Karaoke Night"
          className="w-full px-4 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Location
        </label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="The Tipsy Crow, 123 Main St"
          className="w-full px-4 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Start Time <span className="text-red-400">*</span>
          </label>
          <input
            type="datetime-local"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-full px-4 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            End Time
          </label>
          <input
            type="datetime-local"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full px-4 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      <div className="flex gap-3 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex-1 px-4 py-2 bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : event ? 'Save Changes' : 'Create Event'}
        </button>
      </div>
    </form>
  );
}
