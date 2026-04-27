'use client';

import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { normalizeHandleInput } from '@imajin/config';

const CATEGORY_PRESETS = ['café', 'restaurant', 'shop', 'venue', 'studio', 'bar', 'gallery', 'gym'];
const MAX_IMAGES = 6;

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

interface GalleryImage {
  id: string;
  did: string;
  url: string;
  caption: string | null;
  sortOrder: number;
}

interface StubMeta {
  category?: string;
  location?: string;
  lat?: number;
  lon?: number;
  [key: string]: unknown;
}

interface StubData {
  did: string;
  name: string;
  handle: string | null;
  bio: string | null;
  metadata: StubMeta | null;
  claimStatus: string | null;
  avatar: string | null;
  banner: string | null;
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

export default function EditStubPage() {
  const params = useParams<{ did: string }>();
  const did = decodeURIComponent(params.did);
  const router = useRouter();

  // Data loading
  const [loading, setLoading] = useState(true);
  const [stub, setStub] = useState<StubData | null>(null);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [notFound, setNotFound] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState('');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Geocoding state
  const [resolvedLat, setResolvedLat] = useState<number | null>(null);
  const [resolvedLon, setResolvedLon] = useState<number | null>(null);
  const [geocodeSource, setGeocodeSource] = useState<'address' | 'device' | null>(null);
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const geocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Device location
  const [deviceLoc, setDeviceLoc] = useState<DeviceLocation | null>(null);
  const [deviceLocError, setDeviceLocError] = useState<string | null>(null);
  const [reversingDevice, setReversingDevice] = useState(false);
  const watchIdRef = useRef<number | null>(null);

  // Avatar/banner state
  const [avatar, setAvatar] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Gallery image upload
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch stub + images on mount
  useEffect(() => {
    async function fetchData() {
      try {
        const [stubsRes, imagesRes] = await Promise.all([
          fetch('/profile/api/stubs/mine', { credentials: 'include' }),
          fetch(`/profile/api/stubs/${did}/images`, { credentials: 'include' }),
        ]);

        if (stubsRes.ok) {
          const stubs: StubData[] = await stubsRes.json();
          const found = stubs.find((s) => s.did === did);
          if (found) {
            setStub(found);
            setName(found.name ?? '');
            setHandle(found.handle ?? '');
            setBio(found.bio ?? '');
            setCategory(found.metadata?.category ?? '');
            setLocation(found.metadata?.location ?? '');
            setAvatar(found.avatar ?? null);
            setBanner(found.banner ?? null);
            if (found.metadata?.lat != null && found.metadata?.lon != null) {
              setResolvedLat(Number(found.metadata.lat));
              setResolvedLon(Number(found.metadata.lon));
              setGeocodeSource('address');
            }
          } else {
            setNotFound(true);
          }
        } else {
          setNotFound(true);
        }

        if (imagesRes.ok) {
          const data = await imagesRes.json();
          setImages(data.images ?? []);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [did]);

  // Watch device GPS
  useEffect(() => {
    if (!navigator.geolocation) {
      setDeviceLocError('Geolocation not available');
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setDeviceLoc({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setDeviceLocError(null);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setDeviceLocError('Location permission denied');
        } else {
          setDeviceLocError('Location unavailable');
        }
      },
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

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

  async function handleAvatarBannerUpload(
    file: File,
    field: 'avatar' | 'banner'
  ) {
    const setUpl = field === 'avatar' ? setAvatarUploading : setBannerUploading;
    const setErr = field === 'avatar' ? setAvatarError : setBannerError;
    const setVal = field === 'avatar' ? setAvatar : setBanner;

    setErr(null);
    setUpl(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('context', JSON.stringify({ app: 'profile', feature: field, access: 'public' }));
      const mediaRes = await fetch('/media/api/assets', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!mediaRes.ok) {
        const err = await mediaRes.json().catch(() => ({}));
        setErr(err.error || 'Upload failed');
        return;
      }
      const { url } = await mediaRes.json();

      const patchRes = await fetch(`/profile/api/stubs/${encodeURIComponent(did)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ [field]: url }),
      });
      if (!patchRes.ok) {
        const err = await patchRes.json().catch(() => ({}));
        setErr(err.error || 'Failed to save');
        return;
      }
      setVal(url);
    } catch {
      setErr('Something went wrong. Please try again.');
    } finally {
      setUpl(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);

    try {
      const res = await fetch(`/profile/api/stubs/${did}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          bio: bio.trim() || undefined,
          category: category.trim() || undefined,
          location: location.trim() || undefined,
          lat: resolvedLat ?? undefined,
          lon: resolvedLon ?? undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save');
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(file: File) {
    if (images.length >= MAX_IMAGES) {
      setUploadError(`Maximum ${MAX_IMAGES} images allowed.`);
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      // 1. Upload file to media service
      const form = new FormData();
      form.append('file', file);
      const mediaRes = await fetch('/media/api/assets', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!mediaRes.ok) {
        const err = await mediaRes.json().catch(() => ({}));
        setUploadError(err.error || 'Upload failed');
        return;
      }
      const { url } = await mediaRes.json();

      // 2. Register URL in profile images
      const imgRes = await fetch(`/profile/api/stubs/${did}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url }),
      });
      if (!imgRes.ok) {
        const err = await imgRes.json().catch(() => ({}));
        setUploadError(err.error || 'Failed to save image');
        return;
      }
      const { image } = await imgRes.json();
      setImages((prev) => [...prev, image]);
    } catch {
      setUploadError('Something went wrong. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteImage(id: string) {
    try {
      const res = await fetch(`/profile/api/stubs/${did}/images/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setImages((prev) => prev.filter((img) => img.id !== id));
      }
    } catch {
      // silent
    }
  }

  if (loading) {
    return (
      <div className="max-w-lg mx-auto py-8">
        <div className="bg-[#0a0a0a] border border-white/10 p-8 animate-pulse">
          <div className="h-6 bg-surface-elevated w-1/3 mb-4" />
          <div className="space-y-3">
            <div className="h-10 bg-surface-elevated" />
            <div className="h-10 bg-surface-elevated" />
            <div className="h-10 bg-surface-elevated" />
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !stub) {
    return (
      <div className="max-w-lg mx-auto py-8 text-center">
        <p className="text-muted">Place not found or you don&apos;t have access.</p>
        <button
          onClick={() => router.push('/auth')}
          className="mt-4 text-sm text-warning hover:text-warning/70 transition-colors"
        >
          ← Back to Identity Hub
        </button>
      </div>
    );
  }

  const profileUrl = stub.handle ? `/profile/${stub.handle}` : `/profile/${stub.did}`;

  return (
    <div className="max-w-lg mx-auto py-8 space-y-6">
      {/* Edit form */}
      <div className="bg-[#0a0a0a] border border-white/10 p-8">
        <div className="flex items-start justify-between mb-1">
          <h1 className="text-2xl font-bold text-primary font-mono">Edit Place</h1>
          {stub.claimStatus === 'unclaimed' && (
            <span className="text-[10px] px-2 py-1 bg-warning/20 border border-warning/50 text-warning">
              unclaimed
            </span>
          )}
        </div>
        <p className="text-secondary text-sm mb-6">
          Update details for this community-maintained stub.
        </p>

        {/* Avatar upload */}
        <div className="mb-5">
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-2">
            Avatar
          </label>
          <div className="flex items-center gap-4">
            {avatar ? (
              <img
                src={avatar}
                alt="Avatar"
                className="w-16 h-16 rounded-full object-cover border border-white/10 shrink-0"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-surface-elevated border border-white/10 flex items-center justify-center shrink-0">
                <span className="text-muted text-xs">None</span>
              </div>
            )}
            <div className="flex-1">
              <label className="cursor-pointer inline-block px-3 py-1.5 bg-surface-base border border-white/10 text-xs text-secondary hover:text-primary hover:border-gray-500 transition-colors">
                {avatarUploading ? 'Uploading…' : avatar ? 'Change avatar' : 'Upload avatar'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  disabled={avatarUploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) { handleAvatarBannerUpload(file, 'avatar'); e.target.value = ''; }
                  }}
                />
              </label>
              {avatarError && (
                <p className="mt-1 text-xs text-error">{avatarError}</p>
              )}
            </div>
          </div>
        </div>

        {/* Banner upload */}
        <div className="mb-6">
          <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-2">
            Banner
          </label>
          {banner && (
            <div
              className="w-full h-24 bg-cover bg-center mb-2 border border-white/10"
              style={{ backgroundImage: `url(${banner})` }}
            />
          )}
          <label className="cursor-pointer inline-block px-3 py-1.5 bg-surface-base border border-white/10 text-xs text-secondary hover:text-primary hover:border-gray-500 transition-colors">
            {bannerUploading ? 'Uploading…' : banner ? 'Change banner' : 'Upload banner'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              disabled={bannerUploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) { handleAvatarBannerUpload(file, 'banner'); e.target.value = ''; }
              }}
            />
          </label>
          {bannerError && (
            <p className="mt-1 text-xs text-error">{bannerError}</p>
          )}
        </div>

        <div className="border-t border-white/10 mb-6" />

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Name <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rosetta Café"
              maxLength={100}
              required
              className="w-full bg-surface-base border border-white/10 px-4 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Category
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {CATEGORY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setCategory(category === preset ? '' : preset)}
                  className={`px-3 py-1 text-xs border transition-colors ${
                    category === preset
                      ? 'bg-warning/20 border-amber-500/50 text-warning'
                      : 'bg-surface-base border-white/10 text-secondary hover:border-gray-500'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="or type your own…"
              maxLength={100}
              className="w-full bg-surface-base border border-white/10 px-4 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors"
            />
          </div>

          {/* Location */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-secondary uppercase tracking-wider">
                Location
              </label>
              {deviceLoc ? (
                <span className="text-[10px] text-muted font-mono tabular-nums">
                  📍 {deviceLoc.lat.toFixed(4)}, {deviceLoc.lon.toFixed(4)}
                  <span className="text-muted ml-1">(±{Math.round(deviceLoc.accuracy)}m)</span>
                </span>
              ) : deviceLocError ? (
                <span className="text-[10px] text-muted">{deviceLocError}</span>
              ) : (
                <span className="text-[10px] text-muted">Locating…</span>
              )}
            </div>

            <div className="relative flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={location}
                  onChange={(e) => handleLocationChange(e.target.value)}
                  onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                  onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
                  placeholder="e.g. 123 Main St, Portland OR"
                  maxLength={200}
                  className="w-full bg-surface-base border border-white/10 px-4 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors"
                />

                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-surface-base border border-white/10 overflow-hidden max-h-48 overflow-y-auto">
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectSuggestion(s)}
                        className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-surface-elevated transition-colors border-b border-white/10 last:border-0"
                      >
                        <span className="line-clamp-2">{s.displayName}</span>
                        <span className="text-[10px] text-muted font-mono block mt-0.5">
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
                className="px-3 py-2.5 bg-surface-base border border-white/10 text-secondary hover:text-warning hover:border-amber-500/50 disabled:opacity-30 disabled:hover:text-secondary disabled:hover:border-white/10 transition-colors shrink-0"
              >
                {reversingDevice ? (
                  <span className="text-xs">…</span>
                ) : (
                  <span className="text-sm">📍</span>
                )}
              </button>
            </div>

            {resolvedLat !== null && resolvedLon !== null && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] font-mono text-warning/80 tabular-nums">
                  {resolvedLat.toFixed(5)}, {resolvedLon.toFixed(5)}
                </span>
                <span className="text-[10px] text-muted">
                  via {geocodeSource === 'device' ? 'GPS' : 'address lookup'}
                </span>
                <button
                  type="button"
                  onClick={() => { setResolvedLat(null); setResolvedLon(null); setGeocodeSource(null); }}
                  className="text-[10px] text-muted hover:text-secondary transition-colors"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* Handle */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Handle <span className="text-muted">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted text-sm">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(normalizeHandleInput(e.target.value))}
                placeholder="rosetta_cafe"
                maxLength={30}
                pattern="[a-z0-9_]{3,30}"
                className="w-full bg-surface-base border border-white/10 pl-8 pr-4 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors"
              />
            </div>
            <p className="mt-1 text-xs text-muted">3–30 lowercase letters, numbers, or underscores</p>
          </div>

          {/* Bio */}
          <div>
            <label className="block text-xs font-semibold text-secondary uppercase tracking-wider mb-1.5">
              Bio
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short description of this place…"
              maxLength={500}
              rows={3}
              className="w-full bg-surface-base border border-white/10 px-4 py-2.5 text-primary placeholder-muted focus:outline-none focus:border-imajin-purple transition-colors resize-none"
            />
            <p className="mt-1 text-xs text-muted text-right">{bio.length}/500</p>
          </div>

          {error && (
            <p className="text-sm text-error bg-error/20 border border-red-800/40 px-4 py-3">
              {error}
            </p>
          )}

          {saved && (
            <p className="text-sm text-success bg-success/20 border border-green-800/40 px-4 py-3">
              Saved successfully.
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => router.push('/auth')}
              className="flex-1 px-4 py-2.5 bg-surface-base border border-white/10 text-secondary hover:text-primary hover:border-gray-500 transition-colors text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="flex-1 px-4 py-2.5 bg-warning hover:bg-warning disabled:bg-warning/20 disabled:text-warning text-black font-semibold transition-colors text-sm"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Image Gallery */}
      <div className="bg-[#0a0a0a] border border-white/10 p-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-primary font-mono">Gallery</h2>
            <p className="text-xs text-muted mt-0.5">{images.length} / {MAX_IMAGES} images</p>
          </div>
          {images.length < MAX_IMAGES && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="px-3 py-1.5 bg-surface-base border border-white/10 text-xs text-secondary hover:text-primary hover:border-gray-500 disabled:opacity-40 transition-colors"
            >
              {uploading ? 'Uploading…' : '+ Upload'}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleUpload(file);
                e.target.value = '';
              }
            }}
          />
        </div>

        {uploadError && (
          <p className="text-sm text-error bg-error/20 border border-red-800/40 px-4 py-3 mb-4">
            {uploadError}
          </p>
        )}

        {images.length === 0 ? (
          <div
            className="border-2 border-dashed border-white/10 py-12 text-center cursor-pointer hover:border-gray-600 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <p className="text-muted text-sm">No images yet</p>
            <p className="text-zinc-700 text-xs mt-1">Click to upload the first one</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {images.map((img) => (
              <div key={img.id} className="relative group aspect-square overflow-hidden bg-surface-base">
                <Image
                  src={img.url}
                  alt={img.caption ?? ''}
                  fill
                  className="object-cover"
                  sizes="(max-width: 640px) 33vw, 160px"
                />
                <button
                  type="button"
                  onClick={() => handleDeleteImage(img.id)}
                  className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center bg-surface-base/70 hover:bg-error/80 rounded-full text-primary text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Public profile link */}
      <div className="text-center">
        <a
          href={profileUrl}
          className="text-sm text-muted hover:text-zinc-300 transition-colors"
        >
          View public profile →
        </a>
      </div>
    </div>
  );
}
