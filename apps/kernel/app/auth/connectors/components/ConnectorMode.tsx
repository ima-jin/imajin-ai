'use client';

import { createContext, useContext } from 'react';

export type ConnectorMode = { kind: 'personal' } | OrgConnectorMode;
export const ConnectorModeContext = createContext<ConnectorMode>({ kind: 'personal' });
export const useConnectorMode = () => useContext(ConnectorModeContext);

export interface LoadedKey {
  provider: string;
  status: 'loaded';
  loadedByDid?: string;
  loadedAt: string;
}
export interface Member {
  controllerDid: string;
  name: string | null;
  handle: string | null;
  role: string;
  scope: string;
  subtype: string | null;
  allowedServices: string[] | null;
}
export interface OrgConnectorMode {
  kind: 'org';
  orgDid: string;
  initial?: LoadedKey;
  canManage: boolean;
  members: Member[];
  statusUnavailable: boolean;
}

/** Project only the documented metadata; never retain an arbitrary response. */
export function loadedMetadata(value: LoadedKey): LoadedKey {
  return { provider: value.provider, status: 'loaded', loadedByDid: value.loadedByDid, loadedAt: value.loadedAt };
}
type Section = 'settings' | 'models' | 'billing-key' | 'scopes';
export const ORG_PROVIDER_PARITY_URL = 'https://github.com/ima-jin/imajin-ai/issues/3341';

export function ProviderSectionNotice({ note, followUp }: Readonly<{ note: string | null; followUp?: string | null }>) {
  if (!note) return null;
  return <p className="text-xs text-gray-400">{note}{followUp && <> <a href={followUp}
    className="underline">Provider parity follow-up</a></>}</p>;
}

/** Org management never falls through to a legacy personal credential route. */
export function useProviderSection(provider: string, section: Section, personalRoute: string) {
  const mode = useConnectorMode();
  if (mode.kind === 'personal') return { route: personalRoute, disabled: false, note: null, orgDid: null, followUp: null, showControls: true };
  const supported = (provider === 'anthropic' && section !== 'settings')
    || (provider === 'warp' && section === 'settings');
  let note: string | null = null;
  if (!supported) note = 'Org-held support is pending. This section is disabled; personal credentials are not used.';
  else if (!mode.canManage) note = 'Read-only — only an authorized org admin can manage or test this section.';
  return {
    route: `/connections/api/org-held/${encodeURIComponent(provider)}/${section}`,
    disabled: !mode.canManage || !supported,
    showControls: mode.canManage,
    note,
    followUp: supported ? null : ORG_PROVIDER_PARITY_URL,
    orgDid: mode.orgDid,
  };
}

export function sectionHeaders(orgDid: string | null): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(orgDid ? { 'X-Acting-As': orgDid } : {}) };
}
