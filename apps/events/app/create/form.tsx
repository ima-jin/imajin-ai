'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUpload } from '@/app/components/ImageUpload';
import { MarkdownEditor } from '@imajin/ui';
import { apiFetch, eventPath } from '@imajin/config';

interface Props {
  organizerDid: string;
}

interface TicketTier {
  name: string;
  price: number;
  quantity: number | null;
  description: string;
}

export default function EventCreateForm({ organizerDid }: Readonly<Props>) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Basic info
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [dateTime, setDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');
  const [locationType, setLocationType] = useState<'physical' | 'virtual' | 'hybrid'>('physical');
  const [virtualUrl, setVirtualUrl] = useState('');
  const [venue, setVenue] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [courseSlug, setCourseSlug] = useState('');

  // Event type
  const [eventType, setEventType] = useState<'event' | 'campaign'>('event');
  const [targetAmount, setTargetAmount] = useState('');
  const [campaignDeadline, setCampaignDeadline] = useState('');

  // Ticket tiers
  const [tiers, setTiers] = useState<TicketTier[]>([
    { name: 'General Admission', price: 0, quantity: null, description: '' }
  ]);

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

    try {
      const response = await apiFetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Include cookies for auth
        body: JSON.stringify({
          title: name,
          description: `${tagline ? tagline + '\n\n' : ''}${description}`,
          startsAt: new Date(dateTime).toISOString(),
          endsAt: endDateTime ? new Date(endDateTime).toISOString() : null,
          locationType,
          isVirtual: locationType !== 'physical',
          virtualUrl: locationType === 'physical'  ? null : virtualUrl,
          venue: locationType === 'virtual'  ? null : venue,
          address: locationType === 'virtual'  ? null : address,
          city: locationType === 'virtual'  ? null : city,
          country: locationType === 'virtual'  ? null : country,
          imageUrl: coverImageUrl || null,
          courseSlug: courseSlug || null,
          eventType,
          ...(eventType === 'campaign' && {
            targetAmount: Math.round(Number.parseFloat(targetAmount) * 100),
            deadline: campaignDeadline ? new Date(campaignDeadline).toISOString() : null,
          }),
          tickets: eventType === 'event' ? tiers.filter(t => t.name).map(t => ({
            name: t.name,
            description: t.description,
            price: Math.round(t.price * 100), // Convert to cents
            currency: 'CAD',
            quantity: t.quantity,
          })) : [],
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create event');
      }

      const data = await response.json();
      router.push(eventPath(data.event.id));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create event');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic Info */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold">Basic Info</h2>

        {/* Event Type */}
        <div>
          <span className="block text-sm font-medium mb-2">Event Type</span>
          <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
            {(['event', 'campaign'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setEventType(type)}
                className={`flex-1 py-2 text-sm font-medium transition ${
                  eventType === type
                    ? 'bg-orange-500 text-white'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {type === 'event' ? '🎉 Event' : '💰 Campaign'}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {eventType === 'campaign'
              ? 'Campaigns collect pledges toward a funding goal. Money only moves when the goal is reached.'
              : 'Standard event with ticket sales.'}
          </p>
        </div>

        {/* Campaign fields */}
        {eventType === 'campaign' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl">
            <div>
              <label htmlFor="create-funding-goal" className="block text-sm font-medium mb-1">Funding Goal (CAD) *</label>
              <input
                id="create-funding-goal"
                type="number"
                min="1"
                step="0.01"
                value={targetAmount}
                onChange={(e) => setTargetAmount(e.target.value)}
                required={eventType === 'campaign'}
                placeholder="5000"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
              <p className="text-xs text-gray-500 mt-1">Minimum $1.00</p>
            </div>
            <div>
              <label htmlFor="create-campaign-deadline" className="block text-sm font-medium mb-1">Deadline</label>
              <input
                id="create-campaign-deadline"
                type="datetime-local"
                value={campaignDeadline}
                onChange={(e) => setCampaignDeadline(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
              <p className="text-xs text-gray-500 mt-1">Optional — when pledging closes</p>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="create-event-name" className="block text-sm font-medium mb-1">Event Name *</label>
          <input
            id="create-event-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Jin's Launch Party"
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label htmlFor="create-tagline" className="block text-sm font-medium mb-1">Tagline</label>
          <input
            id="create-tagline"
            type="text"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="A night of light, sound, and presence"
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="create-start-date" className="block text-sm font-medium mb-1">Start Date & Time *</label>
            <input
              id="create-start-date"
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <label htmlFor="create-end-date" className="block text-sm font-medium mb-1">End Date & Time</label>
            <input
              id="create-end-date"
              type="datetime-local"
              value={endDateTime}
              onChange={(e) => setEndDateTime(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>

        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
          {(['physical', 'virtual', 'hybrid'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setLocationType(type)}
              className={`flex-1 py-2 text-sm font-medium transition ${
                locationType === type
                  ? 'bg-orange-500 text-white'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>

        {locationType !== 'physical' && (
          <div>
            <label htmlFor="create-virtual-url" className="block text-sm font-medium mb-1">Virtual URL</label>
            <input
              id="create-virtual-url"
              type="url"
              value={virtualUrl}
              onChange={(e) => setVirtualUrl(e.target.value)}
              placeholder="https://zoom.us/j/..."
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
            />
          </div>
        )}

        {locationType !== 'virtual' && (
          <>
            <div>
              <label htmlFor="create-venue" className="block text-sm font-medium mb-1">Venue</label>
              <input
                id="create-venue"
                type="text"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Event Space Name"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label htmlFor="create-address" className="block text-sm font-medium mb-1">Address</label>
              <input
                id="create-address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="123 Main St"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="create-city" className="block text-sm font-medium mb-1">City</label>
                <input
                  id="create-city"
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Toronto"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label htmlFor="create-country" className="block text-sm font-medium mb-1">Country</label>
                <input
                  id="create-country"
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

        <div>
          <label htmlFor="create-course-slug" className="block text-sm font-medium mb-1">Linked Course Slug</label>
          <input
            id="create-course-slug"
            type="text"
            value={courseSlug}
            onChange={(e) => setCourseSlug(e.target.value)}
            placeholder="intro-to-ai"
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
          />
          <p className="text-xs text-gray-500 mt-1">Optional: link this event to a course on Learn</p>
        </div>

        <ImageUpload
          onUploadComplete={(url) => setCoverImageUrl(url)}
        />

        <div>
          <label className="block">
            <span className="text-sm font-medium block mb-1">Description</span>
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder="Tell people what your event is about..."
            />
          </label>
        </div>
      </div>

      {/* Ticket Tiers — only for regular events */}
      {eventType === 'event' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Tickets</h2>
            <button
              type="button"
              onClick={addTier}
              className="text-orange-500 hover:text-orange-600 text-sm font-medium"
            >
              + Add Tier
            </button>
          </div>

          {tiers.map((tier, index) => (
            <div key={index} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
              <div className="flex justify-between items-start">
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`create-tier-name-${index}`} className="block text-sm font-medium mb-1">Tier Name</label>
                    <input
                      id={`create-tier-name-${index}`}
                      type="text"
                      value={tier.name}
                      onChange={(e) => updateTier(index, 'name', e.target.value)}
                      placeholder="General Admission"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor={`create-tier-price-${index}`} className="block text-sm font-medium mb-1">Price (CAD)</label>
                    <input
                      id={`create-tier-price-${index}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={tier.price}
                      onChange={(e) => updateTier(index, 'price', Number.parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor={`create-tier-quantity-${index}`} className="block text-sm font-medium mb-1">Quantity (blank = unlimited)</label>
                    <input
                      id={`create-tier-quantity-${index}`}
                      type="number"
                      min="1"
                      value={tier.quantity || ''}
                      onChange={(e) => updateTier(index, 'quantity', e.target.value ? Number.parseInt(e.target.value) : null)}
                      placeholder="Unlimited"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor={`create-tier-description-${index}`} className="block text-sm font-medium mb-1">Description</label>
                    <input
                      id={`create-tier-description-${index}`}
                      type="text"
                      value={tier.description}
                      onChange={(e) => updateTier(index, 'description', e.target.value)}
                      placeholder="What's included"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm"
                    />
                  </div>
                </div>
                {tiers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeTier(index)}
                    className="ml-3 text-red-500 hover:text-red-600 text-sm"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-semibold rounded-lg transition"
      >
        {(() => {
          if (loading) return 'Creating...';
          if (eventType === 'campaign') return 'Create Campaign';
          return 'Create Event';
        })()}
      </button>
    </form>
  );
}
