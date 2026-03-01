'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUpload } from '@/app/components/ImageUpload';
import type { Event, TicketType } from '@/src/db/schema';

interface Props {
  event: Event;
  existingTickets: TicketType[];
}

interface TicketTier {
  id?: string;
  name: string;
  price: number;
  quantity: number | null;
  description: string;
  sold?: number;
}

export default function EventEditForm({ event, existingTickets }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Pre-fill form with existing data
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description || '');
  const [dateTime, setDateTime] = useState(
    event.startsAt ? new Date(event.startsAt).toISOString().slice(0, 16) : ''
  );
  const [endDateTime, setEndDateTime] = useState(
    event.endsAt ? new Date(event.endsAt).toISOString().slice(0, 16) : ''
  );
  const [isVirtual, setIsVirtual] = useState(event.isVirtual || false);
  const [virtualUrl, setVirtualUrl] = useState(event.virtualUrl || '');
  const [venue, setVenue] = useState(event.venue || '');
  const [address, setAddress] = useState(event.address || '');
  const [city, setCity] = useState(event.city || '');
  const [country, setCountry] = useState(event.country || '');
  const [imageUrl, setImageUrl] = useState(event.imageUrl || '');
  const [status, setStatus] = useState(event.status);

  // Pre-fill ticket tiers
  const [tiers, setTiers] = useState<TicketTier[]>(
    existingTickets.map(t => ({
      id: t.id,
      name: t.name,
      price: t.price / 100, // Convert cents to dollars
      quantity: t.quantity,
      description: t.description || '',
      sold: t.sold || 0,
    }))
  );

  function addTier() {
    setTiers([...tiers, { name: '', price: 0, quantity: null, description: '' }]);
  }

  function updateTier(index: number, field: keyof TicketTier, value: any) {
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], [field]: value };
    setTiers(newTiers);
  }

  function removeTier(index: number) {
    if (tiers.length > 1) {
      setTiers(tiers.filter((_, i) => i !== index));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    // Validate ticket quantity changes
    for (const tier of tiers) {
      if (tier.sold && tier.quantity !== null && tier.quantity < tier.sold) {
        setError(`Cannot reduce "${tier.name}" quantity below ${tier.sold} (already sold)`);
        setLoading(false);
        return;
      }
    }

    try {
      const response = await fetch(`/api/events/${event.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title,
          description,
          startsAt: new Date(dateTime).toISOString(),
          endsAt: endDateTime ? new Date(endDateTime).toISOString() : null,
          isVirtual,
          virtualUrl: isVirtual ? virtualUrl : null,
          venue: !isVirtual ? venue : null,
          address: !isVirtual ? address : null,
          city: !isVirtual ? city : null,
          country: !isVirtual ? country : null,
          imageUrl: imageUrl || null,
          status,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update event');
      }

      // TODO: Update ticket types separately if needed
      // For now, ticket types are read-only after creation

      router.push(`/${event.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update event');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold">Basic Info</h2>

        <div>
          <label className="block text-sm font-medium mb-1">Event Name *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Start Date & Time *</label>
            <input
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">End Date & Time</label>
            <input
              type="datetime-local"
              value={endDateTime}
              onChange={(e) => setEndDateTime(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isVirtual}
              onChange={(e) => setIsVirtual(e.target.checked)}
              className="w-4 h-4 text-orange-500 focus:ring-orange-500 rounded"
            />
            <span className="text-sm font-medium">Virtual Event</span>
          </label>
        </div>

        {isVirtual ? (
          <div>
            <label className="block text-sm font-medium mb-1">Virtual URL</label>
            <input
              type="url"
              value={virtualUrl}
              onChange={(e) => setVirtualUrl(e.target.value)}
              placeholder="https://zoom.us/j/..."
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">Venue</label>
              <input
                type="text"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Event Space Name"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="123 Main St"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">City</label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Toronto"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Country</label>
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="Canada"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>
          </>
        )}

        <ImageUpload
          currentImage={imageUrl || undefined}
          onUploadComplete={(url) => setImageUrl(url)}
        />

        <div>
          <label className="block text-sm font-medium mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="cancelled">Cancelled</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>

      {/* Ticket Tiers - Read Only for now */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Tickets</h2>
          <span className="text-sm text-gray-500">Read-only after creation</span>
        </div>

        {tiers.map((tier, index) => (
          <div key={index} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Tier Name</label>
                <input
                  type="text"
                  value={tier.name}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Price (CAD)</label>
                <input
                  type="text"
                  value={`$${tier.price.toFixed(2)}`}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity</label>
                <input
                  type="text"
                  value={tier.quantity === null ? 'Unlimited' : tier.quantity}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Sold</label>
                <input
                  type="text"
                  value={tier.sold || 0}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-sm"
                />
              </div>
            </div>
            {tier.description && (
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <p className="text-sm text-gray-600 dark:text-gray-400">{tier.description}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => router.push(`/${event.id}`)}
          className="flex-1 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 font-semibold rounded-lg transition"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex-1 py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-semibold rounded-lg transition"
        >
          {loading ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </form>
  );
}
