'use client';

import React, { useMemo } from 'react';
import type { DidShareList, DidShareEntry } from '@imajin/fair';

interface DidShareListEditorProps {
  value: DidShareList;
  onChange: (value: DidShareList) => void;
  readOnly?: boolean;
  className?: string;
  defaultDid?: string;
  showFixed?: boolean;
}

const ROLE_OPTIONS = [
  'creator', 'collaborator', 'producer', 'performer',
  'platform', 'venue', 'distributor', 'label', 'other',
];

const SUM_TOLERANCE = 1e-6;

export function DidShareListEditor({
  value,
  onChange,
  readOnly = false,
  className = '',
  defaultDid,
  showFixed = false,
}: DidShareListEditorProps) {
  const totalShare = useMemo(
    () => value.reduce((sum, e) => sum + e.share, 0),
    [value],
  );

  const isValid = Math.abs(totalShare - 1.0) <= SUM_TOLERANCE;
  const isOver = totalShare > 1.0 + SUM_TOLERANCE;

  const update = (i: number, patch: Partial<DidShareEntry>) => {
    const next = value.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
    onChange(next);
  };

  const remove = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  const add = () => {
    onChange([
      ...value,
      {
        did: defaultDid ?? '',
        role: 'collaborator',
        share: 0,
      },
    ]);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {value.map((entry, i) => (
        <div key={i} className="bg-[#252525] rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={entry.did ?? ''}
              onChange={(e) => update(i, { did: e.target.value })}
              placeholder="did:key:..."
              readOnly={readOnly}
              className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 read-only:opacity-60"
            />
            <select
              value={entry.role}
              onChange={(e) => update(i, { role: e.target.value })}
              disabled={readOnly}
              className="bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 disabled:opacity-60"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {!readOnly && (
              <button
                onClick={() => remove(i)}
                className="text-gray-600 hover:text-red-400 transition text-sm px-1"
                title="Remove"
                type="button"
              >
                ✕
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={Math.round(entry.share * 1000) / 10}
              onChange={(e) => update(i, { share: parseFloat(e.target.value) / 100 })}
              disabled={readOnly}
              className="flex-1 accent-orange-500 disabled:opacity-60"
            />
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={(entry.share * 100).toFixed(1)}
              onChange={(e) => update(i, { share: parseFloat(e.target.value) / 100 })}
              readOnly={readOnly}
              className="w-16 bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500 text-right read-only:opacity-60"
            />
            <span className="text-xs text-gray-500">%</span>
          </div>
          <input
            type="text"
            value={entry.name ?? ''}
            onChange={(e) => update(i, { name: e.target.value || undefined })}
            placeholder="Name (optional)"
            readOnly={readOnly}
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-500 placeholder-gray-700 focus:outline-none focus:border-orange-500 read-only:opacity-60"
          />
        </div>
      ))}

      {!readOnly && (
        <button
          onClick={add}
          type="button"
          className="w-full py-1.5 rounded border border-dashed border-gray-700 text-xs text-gray-500 hover:border-orange-500 hover:text-orange-400 transition"
        >
          + Add contributor
        </button>
      )}

      <div className="flex items-center justify-between text-xs">
        <span
          className={
            isValid
              ? 'text-gray-500'
              : isOver
                ? 'text-red-400 font-medium'
                : 'text-orange-400 font-medium'
          }
        >
          Total: {(totalShare * 100).toFixed(1)}%
          {!isValid && (
            <span className="ml-1">
              {isOver ? '(must be ≤ 100%)' : '(must equal 100%)'}
            </span>
          )}
        </span>
        <span className="text-gray-600">
          {value.length} {value.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
    </div>
  );
}
