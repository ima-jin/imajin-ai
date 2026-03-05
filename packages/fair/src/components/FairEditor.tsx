'use client';

import { useState, useCallback } from 'react';
import type { FairManifest, FairEntry, FairAccess } from '../types';

export interface FairEditorProps {
  manifest: FairManifest;
  onChange?: (manifest: FairManifest) => void;
  readOnly?: boolean;
  sections?: ('attribution' | 'access' | 'transfer' | 'integrity')[];
  resolveProfile?: (did: string) => Promise<{ name: string; avatar?: string }>;
}

const ROLE_OPTIONS = [
  'creator', 'collaborator', 'producer', 'performer',
  'platform', 'venue', 'distributor', 'label', 'other',
];

const SECTION_DEFAULTS: FairEditorProps['sections'] = ['attribution', 'access', 'transfer', 'integrity'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveAccess(manifest: FairManifest): FairAccess {
  if (typeof manifest.access === 'string') {
    return { type: manifest.access };
  }
  return manifest.access;
}

function shareBar(share: number, role: string) {
  const color =
    role === 'platform' ? 'bg-blue-500' :
    role === 'venue' ? 'bg-purple-500' :
    'bg-orange-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${share * 100}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-300 w-10 text-right">
        {(share * 100).toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function AttributionView({ entries }: { entries: FairEntry[] }) {
  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-orange-400 capitalize">{entry.role}</span>
              <span className="text-xs text-gray-500 truncate max-w-[180px]">{entry.did}</span>
            </div>
          </div>
          {shareBar(entry.share, entry.role)}
          {entry.note && (
            <p className="text-xs text-gray-500 italic">{entry.note}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function AttributionEdit({
  entries,
  onChange,
}: {
  entries: FairEntry[];
  onChange: (entries: FairEntry[]) => void;
}) {
  const update = (i: number, patch: Partial<FairEntry>) => {
    const next = entries.map((e, idx) => idx === i ? { ...e, ...patch } : e);
    onChange(next);
  };

  const remove = (i: number) => onChange(entries.filter((_, idx) => idx !== i));

  const add = () =>
    onChange([...entries, { did: '', role: 'collaborator', share: 0 }]);

  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div key={i} className="bg-[#252525] rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={entry.did}
              onChange={e => update(i, { did: e.target.value })}
              placeholder="did:key:..."
              className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500"
            />
            <select
              value={entry.role}
              onChange={e => update(i, { role: e.target.value })}
              className="bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
            >
              {ROLE_OPTIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <button
              onClick={() => remove(i)}
              className="text-gray-600 hover:text-red-400 transition text-sm px-1"
              title="Remove"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={Math.round(entry.share * 1000) / 10}
              onChange={e => update(i, { share: parseFloat(e.target.value) / 100 })}
              className="flex-1 accent-orange-500"
            />
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={(entry.share * 100).toFixed(1)}
              onChange={e => update(i, { share: parseFloat(e.target.value) / 100 })}
              className="w-16 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 text-right"
            />
            <span className="text-xs text-gray-500">%</span>
          </div>
          <input
            type="text"
            value={entry.note ?? ''}
            onChange={e => update(i, { note: e.target.value || undefined })}
            placeholder="Note (optional)"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-500 placeholder-gray-700 focus:outline-none focus:border-orange-500"
          />
        </div>
      ))}
      <button
        onClick={add}
        className="w-full py-1.5 rounded border border-dashed border-gray-700 text-xs text-gray-500 hover:border-orange-500 hover:text-orange-400 transition"
      >
        + Add contributor
      </button>
    </div>
  );
}

function AccessSection({
  access,
  readOnly,
  onChange,
}: {
  access: FairAccess;
  readOnly: boolean;
  onChange?: (access: FairAccess) => void;
}) {
  const types = ['public', 'private', 'trust-graph'] as const;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {types.map(t => (
          <button
            key={t}
            disabled={readOnly}
            onClick={() => onChange?.({ ...access, type: t })}
            className={`px-3 py-1 rounded text-xs font-medium transition ${
              access.type === t
                ? 'bg-orange-500 text-white'
                : 'bg-[#252525] text-gray-400 hover:bg-[#333]'
            } disabled:cursor-default`}
          >
            {t}
          </button>
        ))}
      </div>

      {(access.type === 'private' || access.type === 'trust-graph') && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">Allowed DIDs</p>
          {(access.allowedDids ?? []).map((did, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="flex-1 text-xs text-gray-400 truncate">{did}</span>
              {!readOnly && (
                <button
                  onClick={() => {
                    const next = [...(access.allowedDids ?? [])];
                    next.splice(i, 1);
                    onChange?.({ ...access, allowedDids: next });
                  }}
                  className="text-gray-600 hover:text-red-400 transition text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <input
              type="text"
              placeholder="did:key:... (press Enter)"
              className="w-full bg-[#252525] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    onChange?.({ ...access, allowedDids: [...(access.allowedDids ?? []), val] });
                    (e.target as HTMLInputElement).value = '';
                  }
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TransferSection({
  transfer,
  readOnly,
  onChange,
}: {
  transfer: FairManifest['transfer'];
  readOnly: boolean;
  onChange?: (t: FairManifest['transfer']) => void;
}) {
  const t = transfer ?? { allowed: false };

  const toggle = (key: keyof typeof t, val: boolean | number) =>
    onChange?.({ ...t, [key]: val });

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={t.allowed}
          disabled={readOnly}
          onChange={e => toggle('allowed', e.target.checked)}
          className="accent-orange-500"
        />
        <span className="text-xs text-gray-300">Transfers allowed</span>
      </label>

      {t.allowed && (
        <>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={t.refundable ?? false}
              disabled={readOnly}
              onChange={e => toggle('refundable', e.target.checked)}
              className="accent-orange-500"
            />
            <span className="text-xs text-gray-300">Refundable</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={t.faceValueCap ?? false}
              disabled={readOnly}
              onChange={e => toggle('faceValueCap', e.target.checked)}
              className="accent-orange-500"
            />
            <span className="text-xs text-gray-300">Face-value cap (no scalping)</span>
          </label>

          <div className="space-y-1">
            <p className="text-xs text-gray-500">Resale royalty to creator</p>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={50}
                step={0.5}
                value={((t.resaleRoyalty ?? 0) * 100)}
                disabled={readOnly}
                onChange={e => toggle('resaleRoyalty', parseFloat(e.target.value) / 100)}
                className="flex-1 accent-orange-500"
              />
              <span className="text-xs text-gray-300 w-10 text-right">
                {((t.resaleRoyalty ?? 0) * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function IntegritySection({ integrity }: { integrity: FairManifest['integrity'] }) {
  if (!integrity) {
    return <p className="text-xs text-gray-600 italic">No integrity data.</p>;
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Hash</span>
        <code className="text-xs text-green-400 truncate">{integrity.hash}</code>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Size</span>
        <span className="text-xs text-gray-300">{integrity.size.toLocaleString()} bytes</span>
      </div>
    </div>
  );
}

// ─── Panel wrapper ───────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#252525] rounded-xl p-4 space-y-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">{title}</h3>
      {children}
    </div>
  );
}

// ─── FairEditor ──────────────────────────────────────────────────────────────

export function FairEditor({
  manifest,
  onChange,
  readOnly = false,
  sections = SECTION_DEFAULTS,
}: FairEditorProps) {
  const [local, setLocal] = useState<FairManifest>(manifest);

  const update = useCallback(
    (patch: Partial<FairManifest>) => {
      const next = { ...local, ...patch };
      setLocal(next);
      onChange?.(next);
    },
    [local, onChange],
  );

  const access = resolveAccess(local);
  const attribution = local.attribution?.length ? local.attribution : (local.chain ?? []);

  const totalShare = attribution.reduce((sum, e) => sum + e.share, 0);
  const shareWarning = totalShare > 1.0001;

  return (
    <div className="bg-[#1a1a1a] text-gray-200 rounded-2xl shadow-xl p-4 space-y-4 w-full max-w-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-orange-500 font-bold text-sm">.fair</span>
          <span className="text-gray-600 text-xs">v{local.fair || local.version || '1.0'}</span>
        </div>
        <span className="text-xs text-gray-600 truncate max-w-[200px]">{local.id}</span>
      </div>

      {/* Attribution */}
      {sections.includes('attribution') && (
        <Panel title="Attribution">
          {shareWarning && (
            <p className="text-xs text-red-400">
              Shares sum to {(totalShare * 100).toFixed(1)}% — must not exceed 100%
            </p>
          )}
          {readOnly ? (
            <AttributionView entries={attribution} />
          ) : (
            <AttributionEdit
              entries={attribution}
              onChange={entries => update({ attribution: entries, chain: entries })}
            />
          )}
        </Panel>
      )}

      {/* Access */}
      {sections.includes('access') && (
        <Panel title="Access">
          <AccessSection
            access={access}
            readOnly={readOnly}
            onChange={a => update({ access: a })}
          />
        </Panel>
      )}

      {/* Transfer */}
      {sections.includes('transfer') && (
        <Panel title="Transfer">
          <TransferSection
            transfer={local.transfer}
            readOnly={readOnly}
            onChange={t => update({ transfer: t })}
          />
        </Panel>
      )}

      {/* Integrity */}
      {sections.includes('integrity') && (
        <Panel title="Integrity">
          <IntegritySection integrity={local.integrity} />
        </Panel>
      )}

      {/* Footer */}
      <div className="text-[10px] text-gray-700 pt-1 border-t border-gray-800">
        <a
          href="https://github.com/ima-jin/.fair"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-orange-500 transition"
        >
          .fair spec
        </a>
        {' '}— transparent attribution for every transaction
      </div>
    </div>
  );
}
