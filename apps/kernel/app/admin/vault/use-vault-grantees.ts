'use client';

import { useEffect, useState } from 'react';
import type { VaultGranteeApiRow, VaultGranteesApiResponse } from './types';

export interface VaultGranteesState {
  loading: boolean;
  grantees: VaultGranteeApiRow[];
  error: string | null;
}

const EMPTY_STATE: VaultGranteesState = { loading: false, grantees: [], error: null };

/**
 * Fetches the OTHER active delegation grantees on `field` (#2450 step 1) —
 * GET /api/vault/grantees/[field] — whenever the Rotate dialog opens.
 * Rotate does not re-issue an existing grantee's copy of the wrapped key,
 * so each one silently stops decrypting unless the operator is warned
 * (re-issuing on rotate is #2450 step 2, not done here — this hook only
 * informs the warning).
 */
export function useVaultGrantees(field: string | null, open: boolean): VaultGranteesState {
  const [state, setState] = useState<VaultGranteesState>(EMPTY_STATE);

  useEffect(() => {
    if (!open || !field) {
      setState(EMPTY_STATE);
      return undefined;
    }

    let cancelled = false;
    setState({ loading: true, grantees: [], error: null });

    fetch(`/api/vault/grantees/${encodeURIComponent(field)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load grantees (${response.status})`);
        }
        return (await response.json()) as VaultGranteesApiResponse;
      })
      .then((data) => {
        if (!cancelled) {
          setState({ loading: false, grantees: data.grantees, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            grantees: [],
            error: err instanceof Error ? err.message : 'Failed to load grantees',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [field, open]);

  return state;
}

/** Shortens a DID for inline display: `did:imajin:abc…xyz`. */
export function shortenDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}…${did.slice(-6)}`;
}

/** One line per grantee: `did:imajin:abc…xyz — purpose "corpus-sync"`. */
export function describeGrantee(grantee: VaultGranteeApiRow): string {
  const who = shortenDid(grantee.grantedTo);
  return grantee.purpose ? `${who} — purpose "${grantee.purpose}"` : who;
}
