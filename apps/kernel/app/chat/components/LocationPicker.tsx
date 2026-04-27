'use client';

import { useState } from 'react';

export interface LocationData {
  lat: number;
  lng: number;
  label?: string;
  accuracy?: number;
}

interface LocationPickerProps {
  onLocationSelected: (location: LocationData) => void;
  disabled?: boolean;
}

type PickerState = 'idle' | 'requesting' | 'confirming' | 'denied';

export function LocationPicker({ onLocationSelected, disabled }: LocationPickerProps) {
  const [state, setState] = useState<PickerState>('idle');
  const [location, setLocation] = useState<LocationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestLocation = () => {
    if (disabled || state !== 'idle') return;
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }
    setState('requesting');
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: LocationData = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
        setLocation(loc);
        setState('confirming');
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setState('denied');
          setError('Location access was denied. Please allow it in your browser settings.');
        } else {
          setState('idle');
          setError('Could not get your location. Please try again.');
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleConfirm = () => {
    if (!location) return;
    onLocationSelected(location);
    setState('idle');
    setLocation(null);
  };

  const handleCancel = () => {
    setState('idle');
    setLocation(null);
    setError(null);
  };

  if (state === 'confirming' && location) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-surface-surface border border-gray-200 dark:border-white/10 p-4 z-10">
        <p className="text-sm font-medium text-gray-800 dark:text-primary mb-2">Share your location?</p>
        <p className="text-xs text-secondary dark:text-secondary mb-1">
          Lat: {location.lat.toFixed(5)}, Lng: {location.lng.toFixed(5)}
        </p>
        {location.accuracy !== undefined && (
          <p className="text-xs text-secondary mb-3">Accuracy: ~{location.accuracy}m</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="flex-1 py-1.5 hover:brightness-110 text-primary text-sm transition"
          >
            Share
          </button>
          <button
            onClick={handleCancel}
            className="flex-1 py-1.5 bg-gray-100 dark:bg-surface-elevated hover:bg-gray-200 dark:hover:bg-surface-elevated text-gray-700 dark:text-primary text-sm transition"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-surface-surface border border-red-200 dark:border-red-800 p-4 z-10">
        <p className="text-sm text-error dark:text-error mb-3">{error}</p>
        <button
          onClick={handleCancel}
          className="w-full py-1.5 bg-gray-100 dark:bg-surface-elevated hover:bg-gray-200 dark:hover:bg-surface-elevated text-gray-700 dark:text-primary text-sm transition"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {error && state === 'idle' && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-error/10 dark:bg-error/30 border border-red-200 dark:border-red-800 p-2 z-10">
          <p className="text-xs text-error dark:text-error">{error}</p>
          <button onClick={() => setError(null)} className="text-xs underline text-error mt-1">Dismiss</button>
        </div>
      )}
      <button
        onClick={requestLocation}
        disabled={disabled || state === 'requesting'}
        className="p-2 hover:bg-gray-100 dark:hover:bg-surface-elevated transition disabled:opacity-50"
        title="Share location"
      >
        {state === 'requesting' ? (
          <span className="text-secondary text-sm animate-pulse">{'\uD83D\uDCCD'}</span>
        ) : (
          '\uD83D\uDCCD'
        )}
      </button>
    </div>
  );
}
