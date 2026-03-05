import React, { useState, useCallback } from 'react';

export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface LocationPickerProps {
  onLocation: (location: LocationData) => void;
  disabled?: boolean;
}

type LocationState = 'idle' | 'loading' | 'done' | 'error';

export function LocationPicker({ onLocation, disabled = false }: LocationPickerProps) {
  const [state, setState] = useState<LocationState>('idle');
  const [location, setLocation] = useState<LocationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported');
      setState('error');
      return;
    }

    setState('loading');
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const loc: LocationData = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        };
        setLocation(loc);
        setState('done');
        onLocation(loc);
      },
      (err) => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setError('Location access denied');
            break;
          case err.POSITION_UNAVAILABLE:
            setError('Location unavailable');
            break;
          case err.TIMEOUT:
            setError('Location request timed out');
            break;
          default:
            setError('Could not get location');
        }
        setState('error');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000, // Cache for 1 minute
      }
    );
  }, [onLocation]);

  const clearLocation = useCallback(() => {
    setLocation(null);
    setState('idle');
  }, []);

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-1 px-2">
        <div className="animate-spin w-3 h-3 border-2 border-orange-500 border-t-transparent rounded-full" />
        <span className="text-xs text-gray-400">Getting location...</span>
      </div>
    );
  }

  if (state === 'done' && location) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-lg">
          📍 {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
        </span>
        <button
          type="button"
          onClick={clearLocation}
          className="text-gray-500 hover:text-red-400 text-xs transition-colors"
          title="Remove location"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={requestLocation}
        disabled={disabled}
        className="p-2 text-gray-500 hover:text-orange-400 disabled:opacity-40 transition-colors"
        title="Attach location"
      >
        📍
      </button>
      {error && (
        <div className="absolute bottom-full mb-1 left-0 text-xs text-red-400 whitespace-nowrap bg-gray-900 px-2 py-1 rounded">
          {error}
        </div>
      )}
    </div>
  );
}
