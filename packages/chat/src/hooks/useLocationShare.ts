'use client';

import { useState, useCallback } from 'react';

interface UseLocationShareResult {
  shareLocation: () => Promise<{ lat: number; lng: number; accuracy?: number }>;
  isSharing: boolean;
  error: Error | null;
}

export function useLocationShare(): UseLocationShareResult {
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const shareLocation = useCallback((): Promise<{ lat: number; lng: number; accuracy?: number }> => {
    setIsSharing(true);
    setError(null);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        const e = new Error('Geolocation is not supported by your browser');
        setError(e);
        setIsSharing(false);
        reject(e);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setIsSharing(false);
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        () => {
          const e = new Error('Unable to get your location');
          setError(e);
          setIsSharing(false);
          reject(e);
        }
      );
    });
  }, []);

  return { shareLocation, isSharing, error };
}
