'use client';

import { useEffect, useState } from 'react';
import { isSiteOwnerDid } from '@/src/lib/apps/domain-choice';

export interface ProvisionSiteOwner {
  groupDid: string;
  role: string;
  scope: string;
  name: string | null;
  handle: string | null;
}

/** Never search the identity directory: this endpoint lists only caller-controlled groups. */
export function useProvisionSiteOwners(visible: boolean) {
  const [groups, setGroups] = useState<ProvisionSiteOwner[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    const load = async () => {
      try {
        const response = await fetch('/auth/api/groups', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to load groups');
        const rows = await response.json() as ProvisionSiteOwner[];
        const controlled = rows.filter(row => ['owner', 'admin'].includes(row.role)
          && ['business', 'community', 'family'].includes(row.scope) && isSiteOwnerDid(row.groupDid));
        if (active) setGroups(controlled);
      } catch {
        if (active) {
          setGroups([]);
          setError('Unable to load groups you control. The node operator remains the default owner.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [visible]);

  return { groups, loading, error };
}
