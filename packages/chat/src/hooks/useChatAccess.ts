'use client';

import { useState, useEffect, useRef } from 'react';
import { useChatConfig } from '../ChatProvider';

interface AccessResult {
  allowed: boolean;
  role: string;
  governance: Record<string, unknown>;
}

interface UseChatAccessResult {
  allowed: boolean;
  role: string;
  governance: Record<string, unknown>;
  isLoading: boolean;
  error: Error | null;
}

const cache = new Map<string, AccessResult>();

export function useChatAccess(did: string): UseChatAccessResult {
  const { authUrl } = useChatConfig();
  const cacheKey = `${authUrl}|${did}`;

  const cached = cache.get(cacheKey);
  const [result, setResult] = useState<AccessResult | null>(cached ?? null);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<Error | null>(null);
  const fetchedKey = useRef<string | null>(cached ? cacheKey : null);

  useEffect(() => {
    if (fetchedKey.current === cacheKey) return;
    fetchedKey.current = cacheKey;

    const cached = cache.get(cacheKey);
    if (cached) {
      setResult(cached);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    fetch(`${authUrl}/api/access/${did}`, { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`Access check failed: ${res.status}`);
        return res.json() as Promise<AccessResult>;
      })
      .then(data => {
        cache.set(cacheKey, data);
        setResult(data);
      })
      .catch(err => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setIsLoading(false));
  }, [cacheKey, authUrl, did]);

  return {
    allowed: result?.allowed ?? false,
    role: result?.role ?? '',
    governance: result?.governance ?? {},
    isLoading,
    error,
  };
}
