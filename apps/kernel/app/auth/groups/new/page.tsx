'use client';

import { useState, useEffect, useRef, useCallback, FormEvent, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { normalizeHandleInput } from '@imajin/config';

const SCOPES = [
  { value: 'community', label: 'Community', icon: '🏛️', desc: 'A public or semi-public group' },
  { value: 'business', label: 'Organization', icon: '🏢', desc: 'A business or project' },
  { value: 'family', label: 'Family', icon: '👨‍👩‍👦', desc: 'A private family group' },
] as const;

type ScopeValue = typeof SCOPES[number]['value'];

const SUBTYPES: Record<ScopeValue, string[]> = {
  business: ['sole_proprietor', 'inc', 'cafe', 'restaurant', 'shop', 'venue', 'studio', 'bar', 'gallery', 'gym', 'nonprofit'],
  community: ['club', 'collective', 'network', 'coop'],
  family: ['birth', 'chosen'],
};

const CATEGORY_PRESETS = ['café', 'restaurant', 'shop', 'venue', 'studio', 'bar', 'gallery', 'gym'];

// Nominatim (OpenStreetMap) — no API key, 1 req/sec rate limit
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

interface GeoResult {
  lat: number;
  lon: number;
  displayName: string;
}

interface DeviceLocation {
  lat: number;
  lon: number;
  accuracy: number;
}

async function forwardGeocode(query: string): Promise<GeoResult[]> {
  const res = await fetch(
    `${NOMINATIM_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`,
    { headers: { 'User-Agent': 'Imajin/1.0 (https://imajin.ai)' } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((r: { lat: string; lon: string; display_name: string }) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName: r.display_name,
  }));
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const res = await fetch(
    `${NOMINATIM_URL}/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
    { headers: { 'User-Agent': 'Imajin/1.0 (https://imajin.ai)' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.display_name || null;
}

function isValidScope(v: string | null): v is ScopeValue {
  return v === 'community' || v === 'business' || v === 'family';
}

function NewGroupForm() {
  const searchParams = useSearchParams();
  const paramScope = searchParams.get('scope');
  const fixedScope = isValidScope(paramScope) ? paramScope : null;

  const [scope, setScope] = useState<ScopeValue>(fixedScope ?? 'community');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [subtype, setSubtype] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  // Geocoding state
  const [location, setLocation] = useState('');
  const [resolvedLat, setResolvedLat] = useState<number | null>(null);
  const [resolvedLon, setResolvedLon] = useState<number | null>(null);
  const [geocodeSource, setGeocodeSource] = useState<'address' | 'device' | null>(null);
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Device location
  const [deviceLoc, setDeviceLoc] = useState<DeviceLocation | null>(null);
  const [deviceLocError, setDeviceLocError] = useState<string | null>(null);
  const [reversingDevice, setReversingDevice] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const geocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleScopeChange(newScope: ScopeValue) {
    setScope(newScope);
    setSubtype('');
  }

  const needsLocation = scope === 'business' || scope === 'community';

  // Watch device GPS
  useEffect(() => {
    if (!needsLocation) return;
    if (!navigator.geolocation) {
      setDeviceLocError('Geolocation not available');
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setDeviceLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setDeviceLocError(null);
      },
      (err) => {
        setDeviceLocError(err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Location unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, [needsLocation]);

  // Debounced forward geocode on address input
  const handleLocationChange = useCallback((value: string) => {
    setLocation(value);
    if (geocodeSource === 'address') {
      setResolvedLat(null);
      setResolvedLon(null);
      setGeocodeSource(null);
    }
    if (geocodeTimerRef.current) clearTimeout(geocodeTimerRef.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    geocodeTimerRef.current = setTimeout(async () => {
      try {
        const results = await forwardGeocode(value);
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 600);
  }, [geocodeSource]);

  function selectSuggestion(result: GeoResult) {
    setLocation(result.displayName);
    setResolvedLat(result.lat);
    setResolvedLon(result.lon);
    setGeocodeSource('address');
    setSuggestions([]);
    setShowSuggestions(false);
  }

  async function useDeviceLocation() {
    if (!deviceLoc) return;
    setReversingDevice(true);
    try {
      const address = await reverseGeocode(deviceLoc.lat, deviceLoc.lon);
      if (address) setLocation(address);
      setResolvedLat(deviceLoc.lat);
      setResolvedLon(deviceLoc.lon);
      setGeocodeSource('device');
      setSuggestions([]);
      setShowSuggestions(false);
    } catch {
      setResolvedLat(deviceLoc.lat);
      setResolvedLon(deviceLoc.lon);
      setGeocodeSource('device');
    } finally {
      setReversingDevice(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setStatus('loading');
    setError('');

    try {
      const res = await fetch('/auth/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          scope,
          name: name.trim(),
          handle: handle.trim() || undefined,
          description: description.trim() || undefined,
          subtype: subtype || undefined,
          category: category.trim() || undefined,
          location: location.trim() || undefined,
          lat: resolvedLat ?? undefined,
          lon: resolvedLon ?? undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(data.error || 'Something went wrong');
        return;
      }

      window.location.href = `/auth/groups/${encodeURIComponent(data.did)}/settings`;
    } catch {
      setStatus('error');
      setError('Failed to create identity');
    }
  }

  const scopeMeta = SCOPES.find(s => s.value === scope)!;
  const subtypeOptions = SUBTYPES[scope] ?? [];

  return (
    <div className="max-w-lg mx-auto py-8">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <div className="mb-6">
          <a href="/auth/groups" className="text-sm text-zinc-500 hover:text-zinc-300 transition">
            ← Back to identities
          </a>
          <h1 className="text-2xl font-bold text-white mt-3 mb-1">Create Identity</h1>
          <p className="text-zinc-400 text-sm">Set up a new group, organization, or family identity.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Scope — badge (fixed) or picker */}
          {fixedScope ? (
            <div className="flex items-center gap-2 pb-1">
              <span className="text-xl">{scopeMeta.icon}</span>
              <span className="text-sm font-semibold text-amber-400 uppercase tracking-wider">{scopeMeta.label}</span>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                Type
              </label>
              <div className="grid grid-cols-3 gap-2">
                {SCOPES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => handleScopeChange(s.value)}
                    className={`p-3 rounded-xl border text-center transition ${
                      scope === s.value
                        ? 'border-amber-500 bg-amber-500/10'
                        : 'border-gray-800 hover:border-gray-700'
                    }`}
                  >
                    <span className="text-xl">{s.icon}</span>
                    <p className={`text-sm font-medium mt-1 ${scope === s.value ? 'text-amber-400' : 'text-zinc-300'}`}>
                      {s.label}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">{s.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Display name"
              required
              maxLength={100}
              className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Handle */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Handle <span className="text-zinc-600">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">@</span>
              <input
                type="text"
                value={handle}
                onChange={e => setHandle(normalizeHandleInput(e.target.value))}
                placeholder="handle"
                maxLength={30}
                className="w-full bg-zinc-900 border border-gray-700 rounded-lg pl-8 pr-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
            <p className="mt-1 text-xs text-zinc-600">3–30 lowercase letters, numbers, or underscores</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
              Bio / Description <span className="text-zinc-600">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe this identity"
              rows={3}
              className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors resize-none"
            />
          </div>

          {/* Subtype pills */}
          {subtypeOptions.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                Subtype <span className="text-zinc-600">(optional)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {subtypeOptions.map(st => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setSubtype(subtype === st ? '' : st)}
                    className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                      subtype === st
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                        : 'bg-zinc-900 border-gray-700 text-zinc-400 hover:border-gray-500'
                    }`}
                  >
                    {st.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Business: Category */}
          {scope === 'business' && (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                Category
              </label>
              <div className="flex flex-wrap gap-2 mb-2">
                {CATEGORY_PRESETS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setCategory(category === preset ? '' : preset)}
                    className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                      category === preset
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                        : 'bg-zinc-900 border-gray-700 text-zinc-400 hover:border-gray-500'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={category}
                onChange={e => setCategory(e.target.value)}
                placeholder="or type your own…"
                maxLength={100}
                className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
          )}

          {/* Business + Community: Location */}
          {needsLocation && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  Location
                </label>
                {deviceLoc ? (
                  <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
                    📍 {deviceLoc.lat.toFixed(4)}, {deviceLoc.lon.toFixed(4)}
                    <span className="text-zinc-600 ml-1">(±{Math.round(deviceLoc.accuracy)}m)</span>
                  </span>
                ) : deviceLocError ? (
                  <span className="text-[10px] text-zinc-600">{deviceLocError}</span>
                ) : (
                  <span className="text-[10px] text-zinc-600">Locating…</span>
                )}
              </div>

              <div className="relative flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={location}
                    onChange={e => handleLocationChange(e.target.value)}
                    onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                    onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
                    placeholder="e.g. 123 Main St, Portland OR"
                    maxLength={200}
                    className="w-full bg-zinc-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
                  />

                  {showSuggestions && suggestions.length > 0 && (
                    <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-zinc-900 border border-gray-700 rounded-lg overflow-hidden shadow-xl max-h-48 overflow-y-auto">
                      {suggestions.map((s, i) => (
                        <button
                          key={i}
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => selectSuggestion(s)}
                          className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors border-b border-gray-800 last:border-0"
                        >
                          <span className="line-clamp-2">{s.displayName}</span>
                          <span className="text-[10px] text-zinc-600 font-mono block mt-0.5">
                            {s.lat.toFixed(5)}, {s.lon.toFixed(5)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={useDeviceLocation}
                  disabled={!deviceLoc || reversingDevice}
                  title="Use device location"
                  className="px-3 py-2.5 bg-zinc-900 border border-gray-700 rounded-lg text-zinc-400 hover:text-amber-400 hover:border-amber-500/50 disabled:opacity-30 disabled:hover:text-zinc-400 disabled:hover:border-gray-700 transition-colors shrink-0"
                >
                  {reversingDevice ? <span className="text-xs">…</span> : <span className="text-sm">📍</span>}
                </button>
              </div>

              {resolvedLat !== null && resolvedLon !== null && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] font-mono text-amber-400/80 tabular-nums">
                    {resolvedLat.toFixed(5)}, {resolvedLon.toFixed(5)}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    via {geocodeSource === 'device' ? 'GPS' : 'address lookup'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setResolvedLat(null); setResolvedLon(null); setGeocodeSource(null); }}
                    className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <a
              href="/auth/groups"
              className="flex-1 px-4 py-2.5 bg-zinc-900 border border-gray-700 rounded-lg text-zinc-400 hover:text-white hover:border-gray-500 transition-colors text-sm font-medium text-center"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={status === 'loading' || !name.trim()}
              className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-900/40 disabled:text-amber-700 text-black font-semibold rounded-lg transition-colors text-sm"
            >
              {status === 'loading' ? 'Creating…' : 'Create Identity'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function NewGroupPage() {
  return (
    <Suspense>
      <NewGroupForm />
    </Suspense>
  );
}
