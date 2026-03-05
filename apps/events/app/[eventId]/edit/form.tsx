'use client';

import { useState, useEffect } from 'react';
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
  perks?: string[];
  sold?: number;
}

interface Survey {
  id: string;
  title: string;
  responseCount?: number;
}

type ActiveTab = 'details' | 'fair';

export default function EventEditForm({ event, existingTickets }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('details');

  // Pre-fill form with existing data
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description || '');
  // Format as local datetime for datetime-local input (avoid UTC conversion drift)
  const toLocalDateTimeString = (date: Date) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const [dateTime, setDateTime] = useState(
    event.startsAt ? toLocalDateTimeString(new Date(event.startsAt)) : ''
  );
  const [endDateTime, setEndDateTime] = useState(
    event.endsAt ? toLocalDateTimeString(new Date(event.endsAt)) : ''
  );
  const [isVirtual, setIsVirtual] = useState(event.isVirtual || false);
  const [virtualUrl, setVirtualUrl] = useState(event.virtualUrl || '');
  const [venue, setVenue] = useState(event.venue || '');
  const [address, setAddress] = useState(event.address || '');
  const [city, setCity] = useState(event.city || '');
  const [country, setCountry] = useState(event.country || '');
  const [imageUrl, setImageUrl] = useState(event.imageUrl || '');
  const [status, setStatus] = useState(event.status);

  // Dykil integration
  const DYKIL_URL = process.env.NEXT_PUBLIC_DYKIL_URL || 'https://dykil.imajin.ai';
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loadingSurveys, setLoadingSurveys] = useState(true);
  interface LinkedSurvey {
    id: string;
    visibility: 'always' | 'pre-event' | 'post-event';
    paywall: boolean;
  }
  const [linkedSurveys, setLinkedSurveys] = useState<LinkedSurvey[]>(
    (event.metadata as any)?.linkedSurveys || 
    // Migrate from old formats
    ((event.metadata as any)?.linkedSurveyIds || [
      (event.metadata as any)?.preEventSurveyId,
      (event.metadata as any)?.postEventSurveyId,
    ].filter(Boolean)).map((id: string) => ({ id, visibility: 'always' as const, paywall: false }))
  );

  // Fetch user's surveys
  useEffect(() => {
    async function fetchSurveys() {
      try {
        const res = await fetch(`${DYKIL_URL}/api/surveys/mine`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setSurveys(data.surveys || []);
        }
      } catch (err) {
        console.error('Failed to fetch surveys:', err);
      } finally {
        setLoadingSurveys(false);
      }
    }
    fetchSurveys();
  }, [DYKIL_URL]);

  // Pre-fill ticket tiers
  const [tiers, setTiers] = useState<TicketTier[]>(
    existingTickets.map(t => ({
      id: t.id,
      name: t.name,
      price: t.price / 100, // Convert cents to dollars
      quantity: t.quantity,
      description: t.description || '',
      perks: Array.isArray(t.perks) ? t.perks.map(String) : [],
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
          metadata: {
            ...(event.metadata as any || {}),
            linkedSurveys,
            // Keep legacy fields for backwards compat
            linkedSurveyIds: null,
            preEventSurveyId: null,
            postEventSurveyId: null,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update event');
      }

      // Update survey event_id for all linked surveys
      for (const survey of linkedSurveys) {
        await fetch(`${DYKIL_URL}/api/surveys/${survey.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            eventId: event.id,
          }),
        });
      }

      // Update ticket tiers
      for (const tier of tiers) {
        if (tier.id) {
          // Update existing tier
          const tierRes = await fetch(`/api/events/${event.id}/tiers`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              tierId: tier.id,
              name: tier.name,
              description: tier.description,
              price: Math.round(tier.price * 100), // Convert dollars to cents
              quantity: tier.quantity,
              perks: tier.perks || [],
            }),
          });
          if (!tierRes.ok) {
            const tierData = await tierRes.json();
            throw new Error(tierData.error || tierData.violations?.join(', ') || `Failed to update tier "${tier.name}"`);
          }
        } else {
          // Create new tier
          const tierRes = await fetch(`/api/events/${event.id}/tiers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              name: tier.name,
              description: tier.description,
              price: Math.round(tier.price * 100),
              quantity: tier.quantity,
              perks: tier.perks || [],
            }),
          });
          if (!tierRes.ok) {
            const tierData = await tierRes.json();
            throw new Error(tierData.error || `Failed to create tier "${tier.name}"`);
          }
        }
      }

      router.push(`/${event.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update event');
    } finally {
      setLoading(false);
    }
  }

  // Extract .fair manifest from event metadata
  const fairManifest = (event.metadata as any)?.fair || null;

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        <button
          type="button"
          onClick={() => setActiveTab('details')}
          className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition ${
            activeTab === 'details'
              ? 'bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-white'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          ✏️ Event Details
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('fair')}
          className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition ${
            activeTab === 'fair'
              ? 'bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-white'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          ⚖️ .fair Attribution
        </button>
      </div>

      {/* .fair Viewer */}
      {activeTab === 'fair' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
          <div>
            <h2 className="text-xl font-semibold mb-1">Attribution Manifest</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Every ticket sold records this .fair — who created value, and what share they earn.
            </p>
          </div>

          {fairManifest ? (
            <>
              {/* Platform split */}
              <div>
                <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-2 uppercase tracking-wide">Revenue Split</h3>
                <div className="space-y-2">
                  {fairManifest.chain?.map((entry: any, i: number) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full ${
                          entry.role === 'platform' ? 'bg-blue-500' : 'bg-orange-500'
                        }`} />
                        <div>
                          <div className="font-medium text-sm">{entry.role}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[280px]">
                            {entry.did}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold">{(entry.share * 100).toFixed(1)}%</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Event distributions */}
              {fairManifest.distributions && fairManifest.distributions.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-2 uppercase tracking-wide">Event Distribution</h3>
                  <p className="text-xs text-gray-400 mb-2">How the event&apos;s share is split among contributors</p>
                  <div className="space-y-2">
                    {fairManifest.distributions.map((entry: any, i: number) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-3 h-3 rounded-full bg-green-500" />
                          <div>
                            <div className="font-medium text-sm">{entry.role}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[280px]">
                              {entry.did}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-lg font-bold">{(entry.share * 100).toFixed(1)}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <details className="group">
                  <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300">
                    View raw manifest
                  </summary>
                  <pre className="mt-2 p-3 bg-gray-900 text-green-400 rounded-lg text-xs overflow-x-auto">
                    {JSON.stringify(fairManifest, null, 2)}
                  </pre>
                </details>
              </div>

              <div className="text-xs text-gray-400">
                <a href="https://github.com/ima-jin/.fair" target="_blank" rel="noopener noreferrer" className="hover:text-orange-500 transition">.fair</a>
                {' '}v{fairManifest.version || '0.2.0'} · Applied to all ticket transactions
              </div>
            </>
          ) : (
            <div className="text-center py-8">
              <div className="text-4xl mb-3">⚖️</div>
              <p className="text-gray-500 dark:text-gray-400">
                No .fair manifest attached to this event yet.
              </p>
              <p className="text-sm text-gray-400 mt-1">
                Events created before .fair was enabled won&apos;t have one automatically.
              </p>
            </div>
          )}
        </div>
      )}

    {activeTab === 'details' && (
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

      {/* Ticket Tiers */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Tickets</h2>
          <button
            type="button"
            onClick={addTier}
            className="text-sm text-orange-500 hover:text-orange-600 font-medium"
          >
            + Add Tier
          </button>
        </div>
        <p className="text-xs text-gray-500">Prices can only decrease. Quantity can&apos;t go below sold count.</p>

        {tiers.map((tier, index) => (
          <div key={index} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Tier Name</label>
                <input
                  type="text"
                  value={tier.name}
                  onChange={(e) => updateTier(index, 'name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Price (CAD)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={tier.price}
                  onChange={(e) => updateTier(index, 'price', parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity {tier.sold ? `(${tier.sold} sold)` : ''}</label>
                <input
                  type="number"
                  min={tier.sold || 0}
                  value={tier.quantity === null ? '' : tier.quantity}
                  onChange={(e) => updateTier(index, 'quantity', e.target.value === '' ? null : parseInt(e.target.value))}
                  placeholder="Unlimited"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
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
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input
                type="text"
                value={tier.description}
                onChange={(e) => updateTier(index, 'description', e.target.value)}
                placeholder="Short description of this tier"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Perks (one per line)</label>
              <textarea
                value={(tier.perks || []).join('\n')}
                onChange={(e) => updateTier(index, 'perks', e.target.value.split('\n').filter(Boolean))}
                rows={4}
                placeholder={"Live stream access\nChat participation\nRecording access"}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-orange-500"
              />
              <p className="text-xs text-gray-500 mt-1">Perks can only be added, not removed (protects existing buyers)</p>
            </div>
            {!tier.id && tiers.length > 1 && (
              <button
                type="button"
                onClick={() => removeTier(index)}
                className="text-xs text-red-500 hover:text-red-600"
              >
                Remove tier
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Surveys */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Surveys</h2>
          <a
            href={`${DYKIL_URL}/create`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-orange-500 hover:text-orange-600 font-medium"
          >
            + Create New Survey
          </a>
        </div>
        <p className="text-xs text-gray-500">
          Link surveys to your event. Attendees will see them on the event page.
        </p>

        <div className="space-y-4">
          {loadingSurveys ? (
            <p className="text-sm text-gray-500">Loading surveys...</p>
          ) : surveys.length === 0 ? (
            <p className="text-sm text-gray-500">No surveys found. Create one first.</p>
          ) : (
            <>
              {linkedSurveys.map((linked, index) => (
                <div key={`${linked.id}-${index}`} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <select
                      value={linked.id}
                      onChange={(e) => {
                        const updated = [...linkedSurveys];
                        updated[index] = { ...updated[index], id: e.target.value };
                        setLinkedSurveys(updated);
                      }}
                      className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
                    >
                      {surveys.map((survey) => (
                        <option key={survey.id} value={survey.id}>
                          {survey.title}
                          {survey.responseCount !== undefined ? ` (${survey.responseCount} responses)` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setLinkedSurveys(linkedSurveys.filter((_, i) => i !== index))}
                      className="px-3 py-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                      title="Remove survey"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400">Show:</label>
                      <select
                        value={linked.visibility}
                        onChange={(e) => {
                          const updated = [...linkedSurveys];
                          updated[index] = { ...updated[index], visibility: e.target.value as LinkedSurvey['visibility'] };
                          setLinkedSurveys(updated);
                        }}
                        className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-orange-500"
                      >
                        <option value="always">Always</option>
                        <option value="pre-event">Pre-event only</option>
                        <option value="post-event">Post-event only</option>
                      </select>
                    </div>

                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={linked.paywall}
                        onChange={(e) => {
                          const updated = [...linkedSurveys];
                          updated[index] = { ...updated[index], paywall: e.target.checked };
                          setLinkedSurveys(updated);
                        }}
                        className="w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                      />
                      <span className="text-gray-600 dark:text-gray-400">Requires ticket</span>
                    </label>
                  </div>
                </div>
              ))}

              {surveys.filter(s => !linkedSurveys.some(ls => ls.id === s.id)).length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const available = surveys.find(s => !linkedSurveys.some(ls => ls.id === s.id));
                    if (available) setLinkedSurveys([...linkedSurveys, { id: available.id, visibility: 'always', paywall: false }]);
                  }}
                  className="text-sm text-orange-500 hover:text-orange-600 font-medium"
                >
                  + Add Survey
                </button>
              )}
            </>
          )}
        </div>
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
    )}
    </div>
  );
}
