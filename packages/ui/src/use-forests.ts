'use client';

import { useState, useEffect } from 'react';
import { getActingAs, setActingAs } from './acting-as';

export interface Forest {
  groupDid: string;
  role: string;
  scope: string;
  name: string | null;
  handle: string | null;
}

export function useForests(authUrl: string | null): {
  forests: Forest[];
  loading: boolean;
  activeForest: string | null;
  setActiveForest: (did: string | null) => void;
} {
  const [forests, setForests] = useState<Forest[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeForest, setActiveForestState] = useState<string | null>(null);

  useEffect(() => {
    setActiveForestState(getActingAs());
  }, []);

  useEffect(() => {
    if (!authUrl) return;
    setLoading(true);
    fetch(`${authUrl}/api/groups`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (Array.isArray(data)) setForests(data);
        else if (data?.groups) setForests(data.groups);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authUrl]);

  function setActiveForest(did: string | null) {
    setActingAs(did);
    setActiveForestState(did);
    window.location.reload();
  }

  return { forests, loading, activeForest, setActiveForest };
}
