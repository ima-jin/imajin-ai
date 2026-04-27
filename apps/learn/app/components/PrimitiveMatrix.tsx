'use client';

import { useEffect, useState } from 'react';

const ROWS = ['Actor', 'Family', 'Community', 'Business'];
const COLS = ['Attestation', 'Communication', 'Attribution', 'Settlement', 'Discovery'];

const ROW_ICONS = ['◆', '◇', '○', '□'];

interface PrimitiveMatrixProps {
  /** Active cells as [row, col] pairs (0-indexed) */
  active?: [number, number][];
  /** Compact mode for mobile */
  compact?: boolean;
}

export function PrimitiveMatrix({ active, compact }: PrimitiveMatrixProps) {
  // Animate cells on change
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    setRendered(false);
    const t = setTimeout(() => setRendered(true), 50);
    return () => clearTimeout(t);
  }, [active]);

  const activeSet = new Set((active || []).map(([r, c]) => `${r},${c}`));
  const showAll = !active; // No active prop = show all cells as checkmarks (the full matrix slide)

  return (
    <div className={compact ? '' : 'w-full'}>
      {/* Column headers — vertical text */}
      <div className="grid gap-1 mb-2" style={{ gridTemplateColumns: `80px repeat(${COLS.length}, 1fr)` }}>
        <div /> {/* empty corner */}
        {COLS.map((col, ci) => (
          <div
            key={ci}
            className={`flex justify-center h-20 transition-colors duration-500 ${ showAll || (active || []).some(([, c]) => c === ci) ? 'text-primary/60' : 'text-primary/20' }`}
          >
            <span
              className="text-[10px] uppercase tracking-wider font-medium whitespace-nowrap origin-center"
              style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}
            >
              {col}
            </span>
          </div>
        ))}
      </div>

      {/* Rows */}
      {ROWS.map((row, ri) => {
        const rowActive = showAll || (active || []).some(([r]) => r === ri);
        return (
          <div
            key={ri}
            className="grid gap-1 mb-1"
            style={{ gridTemplateColumns: `80px repeat(${COLS.length}, 1fr)` }}
          >
            {/* Row label */}
            <div className={`flex items-center gap-2 pr-2 transition-colors duration-500 ${ rowActive ? 'text-primary/70' : 'text-primary/20' }`}>
              <span className="text-xs opacity-50">{ROW_ICONS[ri]}</span>
              <span className="text-xs font-medium truncate">{row}</span>
            </div>

            {/* Cells */}
            {COLS.map((_, ci) => {
              const key = `${ri},${ci}`;
              const isActive = showAll || activeSet.has(key);

              return (
                <div
                  key={ci}
                  className={`aspect-square flex items-center justify-center transition-all duration-700 ${ isActive && rendered ? 'bg-imajin-orange/80 shadow-[0_0_12px_rgba(245,158,11,0.4)]' : isActive && !rendered ? 'bg-surface-card/5 border border-white/10' : 'bg-surface-card/5 border border-white/10' }`}
                >
                  {showAll && (
                    <span className="text-primary/50 text-xs">✓</span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
