'use client';

/**
 * Front door lane on `/jin` (#2598) — the operator authors their own agent-
 * reach gate: which tiers may reach them, which topics are open, which of
 * those get published on the agent card, deliver vs decline per topic, and a
 * daily cap. No curl, no seeds.
 *
 * Operator-gated like `GrantsPanel`: renders nothing for anyone else. Reads
 * and writes ONE route, `/jin/api/front-door`, which sits on top of existing
 * primitives only (identities.metadata, the `agent.reach` consent grant, the
 * registered `broker.consent.*` events) — see `src/lib/jin/front-door.ts`.
 * A save takes effect on the next reach call.
 *
 * Rulings applied (2026-10-05): the anonymous tier is locked to the agent
 * card only; an admitted topic defaults to `deliver`; only the labels the
 * operator opts to publish appear on the card, gate rules stay private.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FrontDoorConfig, FrontDoorMode, FrontDoorTier, FrontDoorTopicConfig } from '@/src/lib/jin/front-door';
import { useFlashNotice } from './use-flash-notice';

interface TopicOption {
  term: string;
  label: string;
}

interface FrontDoorResponse {
  isOperator: boolean;
  config?: FrontDoorConfig;
  topicOptions?: TopicOption[];
  limits?: { minDailyCap: number; maxDailyCap: number };
}

const TIER_ROWS: ReadonlyArray<{ tier: FrontDoorTier; label: string; hint: string; locked?: boolean }> = [
  { tier: 'anonymous', label: 'Anonymous', hint: 'Agent card only — asking or sending needs a credential.', locked: true },
  { tier: 'verified', label: 'Verified', hint: 'Holds a credential on this network.' },
  { tier: 'attested', label: 'Attested', hint: 'Holds a credential and has been vouched for.' },
];

const DEFAULT_LIMITS = { minDailyCap: 1, maxDailyCap: 1000 };
const DEFAULT_CAP_WHEN_ENABLED = 25;

function cloneConfig(config: FrontDoorConfig): FrontDoorConfig {
  return {
    tiers: { ...config.tiers },
    topics: Object.fromEntries(Object.entries(config.topics).map(([term, topic]) => [term, { ...topic }])),
    dailyCap: config.dailyCap,
  };
}

function TierRow({
  tier,
  label,
  hint,
  locked,
  checked,
  onChange,
}: Readonly<{
  tier: FrontDoorTier;
  label: string;
  hint: string;
  locked?: boolean;
  checked: boolean;
  onChange: (tier: FrontDoorTier, checked: boolean) => void;
}>) {
  return (
    <label className="flex items-start gap-2 text-sm text-gray-200" data-testid={`front-door-tier-${tier}`}>
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={locked}
        onChange={(e) => onChange(tier, e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {locked && <span className="ml-2 text-xs text-gray-500">locked</span>}
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
    </label>
  );
}

function TopicRow({
  option,
  topic,
  onChange,
}: Readonly<{
  option: TopicOption;
  topic: FrontDoorTopicConfig;
  onChange: (term: string, patch: Partial<FrontDoorTopicConfig>) => void;
}>) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded border border-gray-800 px-3 py-2"
      data-testid={`front-door-topic-${option.term}`}
    >
      <label className="flex items-center gap-2 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={topic.open}
          onChange={(e) => onChange(option.term, { open: e.target.checked })}
          aria-label={`Open ${option.label}`}
        />
        <span className="font-medium">{option.label}</span>
      </label>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={topic.published}
            disabled={!topic.open}
            onChange={(e) => onChange(option.term, { published: e.target.checked })}
            aria-label={`Publish ${option.label} on card`}
          />
          publish on card
        </label>
        <select
          value={topic.mode}
          disabled={!topic.open}
          onChange={(e) => onChange(option.term, { mode: e.target.value as FrontDoorMode })}
          aria-label={`Mode for ${option.label}`}
          className="text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 disabled:opacity-40"
        >
          <option value="deliver">deliver to Inbox</option>
          <option value="decline">decline</option>
        </select>
      </div>
    </div>
  );
}

function DailyCapField({
  value,
  limits,
  onChange,
}: Readonly<{ value: number | null; limits: { minDailyCap: number; maxDailyCap: number }; onChange: (cap: number | null) => void }>) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-gray-200">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(e) => onChange(e.target.checked ? DEFAULT_CAP_WHEN_ENABLED : null)}
          aria-label="Limit messages per day"
        />
        Limit delivered messages per day
      </label>
      {value !== null && (
        <input
          type="number"
          value={value}
          min={limits.minDailyCap}
          max={limits.maxDailyCap}
          step={1}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Daily cap"
          className="w-24 text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
        />
      )}
    </div>
  );
}

function isValidCap(cap: number | null, limits: { minDailyCap: number; maxDailyCap: number }): boolean {
  return cap === null || (Number.isInteger(cap) && cap >= limits.minDailyCap && cap <= limits.maxDailyCap);
}

export function FrontDoorPanel() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<FrontDoorConfig | null>(null);
  const [draft, setDraft] = useState<FrontDoorConfig | null>(null);
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);

  const { flash, notify } = useFlashNotice(5000);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/jin/api/front-door', { credentials: 'include' });
      if (!res.ok) {
        setVisible(false);
        return;
      }
      const data = (await res.json()) as FrontDoorResponse;
      if (!data.isOperator || !data.config) {
        setVisible(false);
        return;
      }
      setVisible(true);
      setSaved(data.config);
      setDraft(cloneConfig(data.config));
      setOptions(data.topicOptions ?? []);
      setLimits(data.limits ?? DEFAULT_LIMITS);
    } catch {
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);

  const setTier = useCallback((tier: FrontDoorTier, checked: boolean) => {
    setDraft((current) => (current ? { ...current, tiers: { ...current.tiers, [tier]: checked } } : current));
  }, []);

  const setTopic = useCallback((term: string, patch: Partial<FrontDoorTopicConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current.topics[term], ...patch };
      // A closed topic is never advertised.
      if (!next.open) next.published = false;
      return { ...current, topics: { ...current.topics, [term]: next } };
    });
  }, []);

  const setCap = useCallback((dailyCap: number | null) => {
    setDraft((current) => (current ? { ...current, dailyCap } : current));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await fetch('/jin/api/front-door', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const body = (await res.json().catch(() => ({}))) as FrontDoorResponse & { error?: string };
      if (!res.ok || !body.config) {
        notify('err', body.error ?? `Save failed (${res.status})`);
        return;
      }
      setSaved(body.config);
      setDraft(cloneConfig(body.config));
      notify('ok', 'Front door saved — live on the next call.');
    } finally {
      setBusy(false);
    }
  }, [draft, notify]);

  if (!visible || !draft) return null;

  const capValid = isValidCap(draft.dailyCap, limits);

  return (
    <section className="mt-8" data-testid="front-door-panel">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Front door</h2>
          <p className="text-xs text-gray-500">
            Who may reach you, about what, and how. Only the topic labels you publish appear on your agent card; the rules stay private.
          </p>
        </div>
        <button type="button" onClick={() => load()} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          ↺ refresh
        </button>
      </div>

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded text-xs font-medium ${flash.type === 'ok' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
          {flash.msg}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>
      ) : (
        <div className="space-y-4 rounded-lg border border-gray-800 p-4">
          <fieldset className="space-y-2">
            <legend className="text-xs uppercase tracking-wide text-gray-500 mb-1">Who may reach me</legend>
            {TIER_ROWS.map((row) => (
              <TierRow key={row.tier} {...row} checked={draft.tiers[row.tier]} onChange={setTier} />
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs uppercase tracking-wide text-gray-500 mb-1">Topics</legend>
            {options.map((option) => (
              <TopicRow key={option.term} option={option} topic={draft.topics[option.term]} onChange={setTopic} />
            ))}
          </fieldset>

          <fieldset>
            <legend className="text-xs uppercase tracking-wide text-gray-500 mb-1">Daily cap</legend>
            <DailyCapField value={draft.dailyCap} limits={limits} onChange={setCap} />
            {!capValid && (
              <p className="mt-1 text-xs text-red-300">
                Enter a whole number from {limits.minDailyCap} to {limits.maxDailyCap}.
              </p>
            )}
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty || !capValid}
              className="px-2.5 py-1 rounded text-xs font-medium bg-green-700/70 text-green-100 hover:bg-green-600/70 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => saved && setDraft(cloneConfig(saved))}
                disabled={busy}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                discard changes
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
