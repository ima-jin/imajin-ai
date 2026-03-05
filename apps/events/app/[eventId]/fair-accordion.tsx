'use client';

import { useState } from 'react';

interface FairEntry {
  did: string;
  role: string;
  share: number;
  note?: string;
}

interface FairManifest {
  version?: string;
  chain?: FairEntry[];
  distributions?: FairEntry[];
}

interface Props {
  fairManifest: FairManifest | null;
}

export function FairAccordion({ fairManifest }: Props) {
  const [open, setOpen] = useState(false);

  if (!fairManifest || !fairManifest.chain?.length) return null;

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
          {/* Revenue Split */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              Revenue Split
            </h3>
            <div className="space-y-2">
              {fairManifest.chain.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      entry.role === 'platform' ? 'bg-blue-500' : 'bg-orange-500'
                    }`} />
                    <span className="text-sm font-medium capitalize">{entry.role}</span>
                  </div>
                  <span className="text-sm font-bold">{(entry.share * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Distributions */}
          {fairManifest.distributions && fairManifest.distributions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Event Distribution
              </h3>
              <div className="space-y-2">
                {fairManifest.distributions.map((entry, i) => (
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
            .fair v{fairManifest.version || '1.0'} — transparent attribution for every transaction
          </div>
        </div>
      )}
    </div>
  );
}
