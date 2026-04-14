'use client';

import { useState, useEffect } from 'react';
import type { FairManifest, FairEntry, FairFee } from '../types';

/** Normalize share values: if any > 1, assume percentages and divide by 100 */
function normalizeShares(entries: FairEntry[]): FairEntry[] {
  const hasPercentage = entries.some(e => e.share > 1);
  if (!hasPercentage) return entries;
  return entries.map(e => ({ ...e, share: e.share / 100 }));
}

function useDidNames(
  dids: string[],
  resolveProfile?: (did: string) => Promise<{ name: string; avatar?: string }>
): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!resolveProfile || dids.length === 0) return;
    let cancelled = false;
    const toResolve = dids.filter(d => d && !names[d]);
    if (toResolve.length === 0) return;
    Promise.all(
      toResolve.map(async (did) => {
        try {
          const p = await resolveProfile(did);
          return [did, p.name] as const;
        } catch { return [did, null] as const; }
      })
    ).then(results => {
      if (cancelled) return;
      const updates: Record<string, string> = {};
      for (const [did, name] of results) { if (name) updates[did] = name; }
      if (Object.keys(updates).length > 0) setNames(prev => ({ ...prev, ...updates }));
    });
    return () => { cancelled = true; };
  }, [dids.join(','), resolveProfile]);
  return names;
}

function formatDid(did: string, names: Record<string, string>, viewerDid?: string, viewerHandle?: string): string {
  if (viewerDid && did === viewerDid) return viewerHandle ? `@${viewerHandle}` : 'You';
  if (names[did]) return `@${names[did]}`;
  if (did === 'NODE_PLACEHOLDER') return 'This node';
  if (did === 'BUYER_PLACEHOLDER') return 'You (buyer)';
  if (did.length > 24) return did.slice(0, 12) + '…' + did.slice(-8);
  return did;
}

const ROLE_LABELS: Record<string, string> = {
  buyer_credit: 'Buyer credit',
  node: 'Node',
  platform: 'Protocol',
  seller: 'Seller',
  creator: 'Creator',
};

interface FairAccordionProps {
  manifest: FairManifest | null;
  resolveProfile?: (did: string) => Promise<{ name: string; avatar?: string }>;
  /** Actual node DID to replace NODE_PLACEHOLDER in display */
  nodeDid?: string;
  /** Viewer's DID to replace BUYER_PLACEHOLDER in display */
  viewerDid?: string;
  /** Viewer's handle for display */
  viewerHandle?: string;
}

function getAttribution(manifest: FairManifest): FairEntry[] {
  return manifest.attribution?.length ? manifest.attribution : (manifest.chain ?? []);
}

export function FairAccordion({ manifest, resolveProfile, nodeDid, viewerDid, viewerHandle }: FairAccordionProps) {
  const [open, setOpen] = useState(false);

  if (!manifest) return null;

  const rawAttribution = getAttribution(manifest);
  // Resolve placeholders for display
  const resolvedAttribution = rawAttribution.map(e => ({
    ...e,
    did: e.did === 'NODE_PLACEHOLDER' ? (nodeDid || e.did)
       : e.did === 'BUYER_PLACEHOLDER' ? (viewerDid || e.did)
       : e.did,
  }));
  const attribution = normalizeShares(resolvedAttribution);
  if (!attribution.length) return null;

  const allDids = attribution.map(e => e.did).filter(d => d && d !== 'NODE_PLACEHOLDER' && d !== 'BUYER_PLACEHOLDER');
  const didNames = useDidNames(allDids, resolveProfile);

  return (
    <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">⚖️</span>
          <div className="text-left">
            <div className="font-semibold">.fair Attribution</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Who gets paid when you buy a ticket
            </div>
          </div>
        </div>
        <span className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              Revenue Split
            </h3>
            <div className="space-y-2">
              {attribution.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      entry.role === 'platform' ? 'bg-blue-500' : 'bg-orange-500'
                    }`} />
                    <span className="text-sm font-medium">{ROLE_LABELS[entry.role] ?? entry.role.replace(/_/g, ' ')}</span>
                    {entry.did && (
                      <span className="text-xs text-gray-500 truncate max-w-[160px]" title={entry.did}>
                        {formatDid(entry.did, didNames, viewerDid, viewerHandle)}
                      </span>
                    )}
                    {entry.chainProof?.verified && (
                      <span className="inline-flex items-center px-1.5 py-0.5 bg-emerald-900/30 border border-emerald-700/50 rounded-full text-[10px] text-emerald-400">
                        ⛓ verified
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold">{(entry.share * 100).toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>

          {manifest.fees && manifest.fees.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Processing Fees
              </h3>
              <div className="space-y-2">
                {manifest.fees.map((fee: FairFee, i: number) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-gray-400" />
                      <span className="text-sm font-medium">{fee.name}</span>
                      <span className="text-xs text-gray-500">{fee.role}</span>
                    </div>
                    <span className="text-sm font-bold text-gray-500">
                      {fee.minRateBps && fee.minRateBps !== fee.rateBps
                        ? `${(fee.minRateBps / 100).toFixed(1)}–${(fee.rateBps / 100).toFixed(1)}%`
                        : `${(fee.rateBps / 100).toFixed(1)}%`
                      }{fee.fixedCents > 0 ? ` + ${(fee.fixedCents / 100).toFixed(2)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-500 mt-1.5 pl-1">
                Estimated per transaction — actual fee depends on card type. Reconciled after payment.
              </p>
            </div>
          )}

          {manifest.distributions && manifest.distributions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Event Distribution
              </h3>
              <div className="space-y-2">
                {manifest.distributions.map((entry, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                      <span className="text-sm font-medium">{ROLE_LABELS[entry.role] ?? entry.role.replace(/_/g, ' ')}</span>
                    </div>
                    <span className="text-sm font-bold">{(entry.share * 100).toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[10px] text-gray-400 pt-2 border-t border-gray-200 dark:border-gray-700">
            <a
              href="https://github.com/ima-jin/.fair"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-orange-500 transition"
            >
              .fair
            </a>
            {' '}v{manifest.version || manifest.fair || '1.0'} — transparent attribution for every transaction
          </div>
        </div>
      )}
    </div>
  );
}
