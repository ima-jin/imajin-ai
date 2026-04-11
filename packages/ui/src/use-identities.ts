'use client';

import { useState, useEffect } from 'react';
import { getActingAs, setActingAs } from './acting-as';

export interface GroupIdentity {
  groupDid: string;
  role: string;
  scope: string;
  name: string | null;
  handle: string | null;
}

export interface IdentityConfig {
  enabledServices: string[];
  landingService: string | null;
}

export function useIdentities(authUrl: string | null, profileUrl?: string | null): {
  identities: GroupIdentity[];
  loading: boolean;
  activeIdentity: string | null;
  activeConfig: IdentityConfig | null;
  setActiveIdentity: (did: string | null) => void;
} {
  const [identities, setIdentities] = useState<GroupIdentity[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdentity, setActiveIdentityState] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<IdentityConfig | null>(null);

  useEffect(() => {
    setActiveIdentityState(getActingAs());
  }, []);

  useEffect(() => {
    if (!authUrl) return;
    setLoading(true);
    fetch(`${authUrl}/api/groups`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (Array.isArray(data)) setIdentities(data);
        else if (data?.groups) setIdentities(data.groups);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authUrl]);

  useEffect(() => {
    const configBase = profileUrl;
    if (!configBase || !activeIdentity) {
      setActiveConfig(null);
      return;
    }
    fetch(`${configBase}/api/forest/${encodeURIComponent(activeIdentity)}/config/public`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setActiveConfig(data as IdentityConfig);
      })
      .catch(() => {});
  }, [authUrl, profileUrl, activeIdentity]);

  function setActiveIdentity(did: string | null) {
    setActingAs(did);
    setActiveIdentityState(did);
    window.location.reload();
  }

  return { identities, loading, activeIdentity, activeConfig, setActiveIdentity };
}
