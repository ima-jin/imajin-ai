'use client';

import { useState, useEffect } from 'react';
import type { FairManifest, FairEntry } from '../types';

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

function formatDid(did: string, names: Record<string, string>): string {
  if (names[did]) return `@${names[did]}`;
  if (did.length > 24) return did.slice(0, 12) + '…' + did.slice(-8);
  return did;
}

interface FairAccordionProps {
  manifest: FairManifest | null;
  resolveProfile?: (did: string) => Promise<{ name: string; avatar?: string }>;
}

function getAttribution(manifest: FairManifest): FairEntry[] {
  return manifest.attribution?.length ? manifest.attribution : (manifest.chain ?? []);
}

export function FairAccordion({ manifest, resolveProfile }: FairAccordionProps) {
  const [open, setOpen] = useState(false);

  if (!manifest) return null;

  const rawAttribution = getAttribution(manifest);
  const attribution = normalizeShares(rawAttribution);
  if (!attribution.length) return null;

  const allDids = attribution.map(e => e.did).filter(Boolean);
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
                    <span className="text-sm font-medium capitalize">{entry.role}</span>
                    {entry.did && (
                      <span className="text-xs text-gray-500 truncate max-w-[140px]" title={entry.did}>
                        {formatDid(entry.did, didNames)}
                      </span>
                    )}
                    {entry.chainProof?.verified && (
                      <span className="inline-flex items-center px-1.5 py-0.5 bg-emerald-900/30 border border-emerald-700/50 rounded-full text-[10px] text-emerald-400">
                        ⛓ verified
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold">{(entry.share * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>

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
                      <span className="text-sm font-medium capitalize">{entry.role}</span>
                    </div>
                    <span className="text-sm font-bold">{(entry.share * 100).toFixed(1)}%</span>
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
