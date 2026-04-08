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
      <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg p-4 z-10">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">Share your location?</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          Lat: {location.lat.toFixed(5)}, Lng: {location.lng.toFixed(5)}
        </p>
        {location.accuracy !== undefined && (
          <p className="text-xs text-gray-400 mb-3">Accuracy: ~{location.accuracy}m</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            className="flex-1 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded-lg transition"
          >
            Share
          </button>
          <button
            onClick={handleCancel}
            className="flex-1 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded-lg transition"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-gray-900 border border-red-200 dark:border-red-800 rounded-xl shadow-lg p-4 z-10">
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
        <button
          onClick={handleCancel}
          className="w-full py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded-lg transition"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {error && state === 'idle' && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-2 z-10">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          <button onClick={() => setError(null)} className="text-xs underline text-red-500 mt-1">Dismiss</button>
        </div>
      )}
      <button
        onClick={requestLocation}
        disabled={disabled || state === 'requesting'}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition disabled:opacity-50"
        title="Share location"
      >
        {state === 'requesting' ? (
          <span className="text-gray-400 text-sm animate-pulse">{'\uD83D\uDCCD'}</span>
        ) : (
          '\uD83D\uDCCD'
        )}
      </button>
    </div>
  );
}
