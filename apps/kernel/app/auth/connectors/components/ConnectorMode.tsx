'use client';

import { createContext, useContext } from 'react';
import type { OrgConnectorMode } from './OrgConnectorSection';

export type ConnectorMode = { kind: 'personal' } | OrgConnectorMode;
export const ConnectorModeContext = createContext<ConnectorMode>({ kind: 'personal' });
export const useConnectorMode = () => useContext(ConnectorModeContext);

type Section = 'settings' | 'models' | 'billing-key' | 'scopes';

/** Org management never falls through to a legacy personal credential route. */
export function useProviderSection(provider: string, section: Section, personalRoute: string) {
  const mode = useConnectorMode();
  if (mode.kind === 'personal') return { route: personalRoute, disabled: false, note: null, orgDid: null };
  const supported = (provider === 'anthropic' && section !== 'settings')
    || (provider === 'warp' && section === 'settings');
  let note: string | null = null;
  if (!supported) note = 'Org-held support pending #3341. This section is disabled; personal credentials are not used.';
  else if (!mode.canManage) note = 'Read-only — only an authorized org admin can manage or test this section.';
  return {
    route: `/connections/api/org-held/${encodeURIComponent(provider)}/${section}`,
    disabled: !mode.canManage || !supported,
    note,
    orgDid: mode.orgDid,
  };
}

export function sectionHeaders(orgDid: string | null): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(orgDid ? { 'X-Acting-As': orgDid } : {}) };
}
