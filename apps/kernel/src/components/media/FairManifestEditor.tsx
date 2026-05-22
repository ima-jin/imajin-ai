'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import type {
  FairManifestV1_1,
  DidShareList,
  Money,
  FairDistributionRight,
  FairTraining,
  FairCommercial,
  FairTransferV1_1,
  FairAccessV1_1,
} from '@imajin/fair';
import { validateManifest } from '@imajin/fair';
import { DidShareListEditor, MoneyInput } from '@imajin/ui';

const CONNECTIONS_URL_BASE = process.env.NEXT_PUBLIC_CONNECTIONS_URL || 'https://jin.imajin.ai/connections';
const CONNECTIONS_API_URL = `${CONNECTIONS_URL_BASE}/api/connections`;

const PROFILE_URL = process.env.NEXT_PUBLIC_SERVICE_PREFIX
  ? `${process.env.NEXT_PUBLIC_SERVICE_PREFIX}profile.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}`
  : 'https://profile.imajin.ai';

async function resolveProfile(did: string): Promise<{ name: string; handle?: string; avatar?: string } | null> {
  try {
    const res = await fetch(`${PROFILE_URL}/api/profile/${encodeURIComponent(did)}`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.handle || data.name || did.slice(0, 16) + '…',
      handle: data.handle,
      avatar: data.avatar,
    };
  } catch {
    return null;
  }
}

interface SectionProps {
  title: string;
  error?: boolean;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function Section({ title, error, children, defaultOpen = false }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[#252525] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        type="button"
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#2a2a2a] transition"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
            {title}
          </span>
          {error && (
            <span className="w-2 h-2 rounded-full bg-red-500" title="Has errors" />
          )}
        </div>
        <span className={`text-gray-500 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  readOnly,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-orange-500 disabled:opacity-60"
      />
      <span className="text-xs text-gray-300">{label}</span>
    </label>
  );
}

const DIST_MODES = [
  { value: 'allowed', label: 'Allowed' },
  { value: 'allow-with-attribution', label: 'With attribution' },
  { value: 'allow-with-share', label: 'With revenue share' },
  { value: 'quote-with-attribution', label: 'Quote only' },
  { value: 'reserved', label: 'Reserved' },
];

function DistributionRightEditor({
  right,
  onChange,
  readOnly,
  connectionsUrl,
  resolveProfile,
}: {
  right?: FairDistributionRight;
  onChange: (r: FairDistributionRight | undefined) => void;
  readOnly?: boolean;
  connectionsUrl?: string;
  resolveProfile?: (did: string) => Promise<{ name: string; handle?: string; avatar?: string } | null>;
}) {
  const mode = right?.mode ?? 'reserved';
  const canHavePrice = mode === 'allowed' || mode === 'allow-with-share' || mode === 'allow-with-attribution';
  const hasPrice = canHavePrice && !!right?.price && right.price.amount > 0;
  const showSplits = mode === 'allow-with-share';
  const showQuote = mode === 'quote-with-attribution';
  const showSampling = showQuote; // for audio

  return (
    <div className="space-y-2">
      <select
        value={mode}
        onChange={(e) => {
          const newMode = e.target.value;
          // When switching modes, strip the price if moving to a non-priceable mode
          const isPriceable = newMode === 'allowed' || newMode === 'allow-with-share' || newMode === 'allow-with-attribution';
          const { price: _price, ...rest } = right ?? {};
          onChange(isPriceable ? { ...right, mode: newMode } : { ...rest, mode: newMode });
        }}
        disabled={readOnly}
        className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 disabled:opacity-60"
      >
        {DIST_MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {canHavePrice && (
        <div className="space-y-2">
          <Toggle
            label="Set a price"
            checked={hasPrice}
            onChange={(checked) => {
              if (checked) {
                onChange({ ...right, price: { amount: 100, currency: 'USD' } });
              } else {
                // Remove price entirely — free access
                const { price: _p, ...rest } = right ?? {};
                onChange({ ...rest, mode: right?.mode ?? 'allowed' });
              }
            }}
            readOnly={readOnly}
          />
          {hasPrice && (
            <MoneyInput
              value={right?.price}
              onChange={(price) => {
                if (!price || price.amount === 0) {
                  // Clearing price or setting to 0 → remove price (free)
                  const { price: _p, ...rest } = right ?? {};
                  onChange({ ...rest, mode: right?.mode ?? 'allowed' });
                } else {
                  onChange({ ...right, price });
                }
              }}
              readOnly={readOnly}
            />
          )}
          {!hasPrice && (
            <p className="text-[10px] text-gray-500">Free — no payment required</p>
          )}
        </div>
      )}

      {showSplits && (
        <DidShareListEditor
          value={right?.splits ?? [{ role: 'creator', share: 1 }]}
          onChange={(splits) => onChange({ ...right, splits })}
          readOnly={readOnly}
          connectionsUrl={connectionsUrl}
          resolveProfile={resolveProfile}
        />
      )}

      {showQuote && (
        <div className="flex gap-2">
          <div className="flex-1">
            <span className="text-[10px] text-gray-500">Max %</span>
            <input
              type="number"
              value={right?.quote?.maxPercent ?? ''}
              onChange={(e) => {
                const val = e.target.value ? Number.parseFloat(e.target.value) : undefined;
                onChange({ ...right, quote: { ...right?.quote, maxPercent: val } });
              }}
              readOnly={readOnly}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 read-only:opacity-60"
            />
          </div>
          <div className="flex-1">
            <span className="text-[10px] text-gray-500">Max words</span>
            <input
              type="number"
              value={right?.quote?.maxWords ?? ''}
              onChange={(e) => {
                const val = e.target.value ? parseInt(e.target.value) : undefined;
                onChange({ ...right, quote: { ...right?.quote, maxWords: val } });
              }}
              readOnly={readOnly}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 read-only:opacity-60"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function mimeBucket(mimeType: string): 'text' | 'image' | 'audio' | 'video' | 'other' {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

// ─── Debounce hook ─────────────────────────────────────────────────────────

function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: Parameters<T>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delay);
    },
    [fn, delay]
  );
}

// ─── FairManifestEditor ────────────────────────────────────────────────────

export interface FairManifestEditorProps {
  manifest: FairManifestV1_1;
  mimeType?: string;
  onChange: (manifest: FairManifestV1_1) => void;
  onSave?: () => void;
  readOnly?: boolean;
  currentUserDid?: string;
  connectionsUrl?: string;
  resolveProfile?: (did: string) => Promise<{ name: string; handle?: string; avatar?: string } | null>;
}

export function FairManifestEditor({
  manifest,
  mimeType = 'application/octet-stream',
  onChange,
  onSave,
  readOnly = false,
  currentUserDid,
  connectionsUrl = CONNECTIONS_API_URL,
  resolveProfile: resolveProfileProp = resolveProfile,
}: FairManifestEditorProps) {
  const [local, setLocal] = useState<FairManifestV1_1>(manifest);
  const [validation, setValidation] = useState<{ ok: boolean; errors: string[] }>({
    ok: true,
    errors: [],
  });
  const [sectionErrors, setSectionErrors] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLocal(manifest);
  }, [manifest]);

  const update = useCallback(
    (patch: Partial<FairManifestV1_1>) => {
      const next = { ...local, ...patch };
      setLocal(next);
      onChange(next);
    },
    [local, onChange]
  );

  const debouncedValidate = useDebouncedCallback((m: FairManifestV1_1) => {
    const result = validateManifest(m);
    setValidation(result);

    // Map errors to sections
    const errors: Record<string, boolean> = {};
    for (const err of result.errors) {
      if (err.startsWith('attribution')) errors.attribution = true;
      if (err.startsWith('training')) errors.training = true;
      if (err.startsWith('commercial')) errors.commercial = true;
      if (err.startsWith('distribution')) errors.distribution = true;
      if (err.startsWith('transfer')) errors.transfer = true;
      if (err.startsWith('access')) errors.access = true;
    }
    setSectionErrors(errors);
  }, 300);

  useEffect(() => {
    debouncedValidate(local);
  }, [local, debouncedValidate]);

  const bucket = useMemo(() => mimeBucket(mimeType), [mimeType]);

  const attribution = local.attribution ?? [];
  const training = local.training ?? { allowed: false };
  const commercial = local.commercial ?? { allowed: false };
  const distribution = local.distribution ?? {};
  const transfer = local.transfer ?? { allowed: false };
  const access =
    typeof local.access === 'string'
      ? ({ type: local.access } as FairAccessV1_1)
      : local.access ?? ({ type: 'private' } as FairAccessV1_1);

  // Signed manifest display
  const isSigned = !!local.signature;
  const isSigner = isSigned && currentUserDid === local.signature?.signer;

  return (
    <div className="bg-[#1a1a1a] text-gray-200 rounded-2xl shadow-xl p-4 space-y-4 w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-orange-500 font-bold text-sm">.fair</span>
          <span className="text-gray-600 text-xs">v{local.version || local.fair || '1.0'}</span>
          {isSigned && (
            <span className="text-[10px] px-1.5 py-0.5 bg-emerald-900/30 border border-emerald-700/50 rounded-full text-emerald-400">
              {isSigner
                ? 'Signed by you'
                : `Signed by ${local.signature!.signer.slice(0, 16)}…`}
            </span>
          )}
        </div>
        {isSigned && isSigner && (
          <span className="text-[10px] text-gray-500">(re-signing on save)</span>
        )}
      </div>

      {/* Signature details */}
      {isSigned && (
        <div className="bg-[#1a1a1a] rounded-lg p-2 space-y-1">
          <p className="text-[10px] text-gray-500">
            Signed by{' '}
            <code className="text-gray-400">{local.signature!.signer}</code>
            {' '}on{' '}
            {local.signature!.signedAt
              ? new Date(local.signature!.signedAt).toLocaleDateString()
              : 'unknown date'}
          </p>
          {/* DFOS anchoring — from #897 / #882 */}
          {'fair_dfos_event_id' in local && (local as Record<string, unknown>).fair_dfos_event_id && (
            <p className="text-[10px] text-gray-500">
              Anchored on DFOS:{" "}
              <code className="text-gray-400">
                {(local as Record<string, unknown>).fair_dfos_event_id as string}
              </code>
            </p>
          )}
        </div>
      )}

      {/* Validation summary */}
      {!validation.ok && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-2">
          <p className="text-xs text-red-400 font-medium">
            {validation.errors.length} validation error{validation.errors.length > 1 ? 's' : ''}
          </p>
        </div>
      )}

      {/* Attribution */}
      <Section title="Attribution split" error={sectionErrors.attribution} defaultOpen>
        <DidShareListEditor
          value={attribution}
          onChange={(entries) => update({ attribution: entries })}
          readOnly={readOnly}
          defaultDid={currentUserDid}
          connectionsUrl={connectionsUrl}
          resolveProfile={resolveProfileProp}
        />
      </Section>

      {/* AI Training opt-out — visually prominent */}
      <div className="bg-[#1e1e2e] border border-orange-500/30 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <span className="text-xs font-semibold text-orange-400 uppercase tracking-widest">
            AI Training
          </span>
        </div>
        <p className="text-xs text-gray-400">
          Allow this asset to be used in AI training datasets. Disabling this opts your work out
          of being used to train machine learning models.
        </p>
        <Toggle
          label="Allow AI training"
          checked={training.allowed}
          onChange={(allowed) => update({ training: { ...training, allowed } })}
          readOnly={readOnly}
        />
      </div>

      {/* Commercial use */}
      <Section title="Commercial use" error={sectionErrors.commercial}>
        <Toggle
          label="Allow commercial use"
          checked={commercial.allowed}
          onChange={(allowed) => update({ commercial: { ...commercial, allowed } })}
          readOnly={readOnly}
        />
        {commercial.allowed && (
          <Toggle
            label="Contact required for commercial licensing"
            checked={commercial.contactRequired ?? false}
            onChange={(contactRequired) =>
              update({ commercial: { ...commercial, contactRequired } })
            }
            readOnly={readOnly}
          />
        )}
      </Section>

      {/* Distribution actions */}
      <Section title="Distribution" error={sectionErrors.distribution}>
        <div className="space-y-3">
          {(['reproduction', 'streaming', 'derivative', 'syndication'] as const).map((key) => (
            <div key={key} className="bg-[#1a1a1a] rounded-lg p-3 space-y-2">
              <p className="text-xs font-medium text-gray-400 capitalize">{key}</p>
              <DistributionRightEditor
                right={distribution[key]}
                onChange={(r) => update({ distribution: { ...distribution, [key]: r } })}
                readOnly={readOnly}
                connectionsUrl={connectionsUrl}
                resolveProfile={resolveProfileProp}
              />
            </div>
          ))}
        </div>
      </Section>

      {/* Transfer */}
      <Section title="Transfer" error={sectionErrors.transfer}>
        <div className="space-y-3">
          <Toggle
            label="Transfers allowed"
            checked={transfer.allowed}
            onChange={(allowed) =>
              update({ transfer: { ...transfer, allowed } as FairTransferV1_1 })
            }
            readOnly={readOnly}
          />
          {transfer.allowed && (
            <>
              <Toggle
                label="Requires attribution on transfer"
                checked={transfer.requiresAttribution ?? false}
                onChange={(requiresAttribution) =>
                  update({
                    transfer: { ...transfer, requiresAttribution } as FairTransferV1_1,
                  })
                }
                readOnly={readOnly}
              />
              <div>
                <p className="text-xs text-gray-500 mb-1">Transfer price</p>
                <MoneyInput
                  value={transfer.price}
                  onChange={(price) =>
                    update({ transfer: { ...transfer, price } as FairTransferV1_1 })
                  }
                  readOnly={readOnly}
                />
              </div>
              {transfer.price && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Revenue split on transfer</p>
                  <DidShareListEditor
                    value={transfer.splits ?? [{ role: 'creator', share: 1 }]}
                    onChange={(splits) =>
                      update({ transfer: { ...transfer, splits } as FairTransferV1_1 })
                    }
                    readOnly={readOnly}
                    defaultDid={currentUserDid}
                    connectionsUrl={connectionsUrl}
                    resolveProfile={resolveProfileProp}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </Section>

      {/* Access */}
      <Section title="Access" error={sectionErrors.access}>
        <div className="flex gap-2 flex-wrap">
          {(['public', 'private', 'trust-graph', 'conversation'] as const).map((t) => (
            <button
              key={t}
              disabled={readOnly}
              onClick={() => update({ access: { ...access, type: t } })}
              className={`px-3 py-1 rounded text-xs font-medium transition ${
                access.type === t
                  ? 'bg-orange-500 text-white'
                  : 'bg-[#252525] text-gray-400 hover:bg-[#333]'
              } disabled:cursor-default`}
              type="button"
            >
              {t}
            </button>
          ))}
        </div>
        {access.type === 'conversation' && (
          <input
            type="text"
            value={access.conversationDid ?? ''}
            onChange={(e) => update({ access: { ...access, conversationDid: e.target.value } })}
            placeholder="did:key:... (conversation)"
            readOnly={readOnly}
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 read-only:opacity-60"
          />
        )}
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
                      update({ access: { ...access, allowedDids: next } });
                    }}
                    className="text-gray-600 hover:text-red-400 transition text-xs"
                    type="button"
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
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      update({
                        access: {
                          ...access,
                          allowedDids: [...(access.allowedDids ?? []), val],
                        },
                      });
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }}
              />
            )}
          </div>
        )}
      </Section>

      {/* Type-specific */}
      {bucket !== 'other' && (
        <Section title={`Type-specific (${bucket})`}>
          {bucket === 'text' && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">Quote limits for reproduction</p>
              <div className="flex gap-2">
                <div className="flex-1">
                  <span className="text-[10px] text-gray-500">Max %</span>
                  <input
                    type="number"
                    value={distribution.reproduction?.quote?.maxPercent ?? ''}
                    onChange={(e) => {
                      const val = e.target.value ? Number.parseFloat(e.target.value) : undefined;
                      update({
                        distribution: {
                          ...distribution,
                          reproduction: {
                            ...distribution.reproduction,
                            quote: { ...distribution.reproduction?.quote, maxPercent: val },
                          },
                        },
                      });
                    }}
                    readOnly={readOnly}
                    className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 read-only:opacity-60"
                  />
                </div>
                <div className="flex-1">
                  <span className="text-[10px] text-gray-500">Max words</span>
                  <input
                    type="number"
                    value={distribution.reproduction?.quote?.maxWords ?? ''}
                    onChange={(e) => {
                      const val = e.target.value ? parseInt(e.target.value) : undefined;
                      update({
                        distribution: {
                          ...distribution,
                          reproduction: {
                            ...distribution.reproduction,
                            quote: { ...distribution.reproduction?.quote, maxWords: val },
                          },
                        },
                      });
                    }}
                    readOnly={readOnly}
                    className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 read-only:opacity-60"
                  />
                </div>
              </div>
            </div>
          )}
          {bucket === 'audio' && (
            <div className="space-y-2">
              <Toggle
                label="Allow sampling (with share)"
                checked={(distribution.derivative?.sampling?.allowed ?? '') === 'allow-with-share'}
                onChange={(checked) =>
                  update({
                    distribution: {
                      ...distribution,
                      derivative: {
                        ...distribution.derivative,
                        sampling: {
                          allowed: checked ? 'allow-with-share' : 'reserved',
                          share: distribution.derivative?.sampling?.share ?? 0.05,
                        },
                      },
                    },
                  })
                }
                readOnly={readOnly}
              />
              <Toggle
                label="Allow sync licensing"
                checked={(distribution.derivative?.sync?.allowed ?? '') === 'allowed'}
                onChange={(checked) =>
                  update({
                    distribution: {
                      ...distribution,
                      derivative: {
                        ...distribution.derivative,
                        sync: {
                          allowed: checked ? 'allowed' : 'reserved',
                        },
                      },
                    },
                  })
                }
                readOnly={readOnly}
              />
            </div>
          )}
          {bucket === 'video' && (
            <Toggle
              label="Allow sync licensing"
              checked={(distribution.derivative?.sync?.allowed ?? '') === 'allowed'}
              onChange={(checked) =>
                update({
                  distribution: {
                    ...distribution,
                    derivative: {
                      ...distribution.derivative,
                      sync: {
                        allowed: checked ? 'allowed' : 'reserved',
                      },
                    },
                  },
                })
              }
              readOnly={readOnly}
            />
          )}
        </Section>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-800">
        <div className="text-[10px] text-gray-700">
          <a
            href="https://github.com/ima-jin/.fair"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-orange-500 transition"
          >
            .fair spec
          </a>
          {' '}— transparent attribution
        </div>
        {!readOnly && onSave && (
          <button
            onClick={onSave}
            disabled={!validation.ok}
            className="px-4 py-1.5 text-xs bg-orange-500 text-white rounded-md hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            type="button"
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}
