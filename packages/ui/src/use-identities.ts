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
  // Named `rawActiveIdentity`/`setRawActiveIdentity` (rather than
  // `activeIdentity`/`setActiveIdentity`) so the raw useState pair follows
  // the `[thing, setThing]` naming convention (S6754) without colliding with
  // the `setActiveIdentity` wrapper function defined below, which also
  // persists the choice via `setActingAs` and reloads the page.
  const [rawActiveIdentity, setRawActiveIdentity] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<IdentityConfig | null>(null);

  useEffect(() => {
    setRawActiveIdentity(getActingAs());
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
    if (!configBase || !rawActiveIdentity) {
      setActiveConfig(null);
      return;
    }
    fetch(`${configBase}/api/forest/${encodeURIComponent(rawActiveIdentity)}/config/public`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setActiveConfig(data as IdentityConfig);
      })
      .catch(() => {});
  }, [authUrl, profileUrl, rawActiveIdentity]);

  function setActiveIdentity(did: string | null) {
    setActingAs(did);
    setRawActiveIdentity(did);
    globalThis.location.reload();
  }

  return { identities, loading, activeIdentity: rawActiveIdentity, activeConfig, setActiveIdentity };
}
