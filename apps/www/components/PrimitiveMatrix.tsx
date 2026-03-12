'use client';

import matrixData from '../../../docs/matrix-status.json';

const SCOPES = matrixData.scopes;
const PRIMITIVES = matrixData.primitives;
const SCOPE_ICONS = ['◆', '◇', '○', '□'];

function getPercent(scope: string, primitive: string): number {
  const key = `${scope}×${primitive}`;
  const cell = (matrixData.cells as Record<string, { percent: number }>)[key];
  return cell?.percent ?? 0;
}

function getOverallPercent(): number {
  const values = Object.values(matrixData.cells as Record<string, { percent: number }>);
  const sum = values.reduce((acc, v) => acc + v.percent, 0);
  return Math.round(sum / values.length);
}

function barColor(pct: number): string {
  if (pct === 0) return 'bg-white/5';
  if (pct < 20) return 'bg-amber-500/30';
  if (pct < 50) return 'bg-amber-500/50';
  if (pct < 75) return 'bg-amber-500/70';
  return 'bg-amber-500/90';
}

function glowClass(pct: number): string {
  if (pct >= 75) return 'shadow-[0_0_8px_rgba(245,158,11,0.3)]';
  if (pct >= 50) return 'shadow-[0_0_4px_rgba(245,158,11,0.15)]';
  return '';
}

export function PrimitiveMatrix() {
  const overall = getOverallPercent();

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Column headers — vertical text */}
      <div
        className="grid gap-1 mb-2"
        style={{ gridTemplateColumns: `100px repeat(${PRIMITIVES.length}, 1fr)` }}
      >
        <div /> {/* empty corner */}
        {PRIMITIVES.map((col, ci) => (
          <div key={ci} className="flex justify-center h-20 text-white/50">
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
      {SCOPES.map((scope, ri) => (
        <div
          key={ri}
          className="grid gap-1 mb-1"
          style={{ gridTemplateColumns: `100px repeat(${PRIMITIVES.length}, 1fr)` }}
        >
          {/* Row label */}
          <div className="flex items-center gap-1.5 pr-2 text-white/60">
            <span className="text-xs opacity-40">{SCOPE_ICONS[ri]}</span>
            <span className="text-xs font-medium">{scope}</span>
          </div>

          {/* Cells */}
          {PRIMITIVES.map((primitive, ci) => {
            const pct = getPercent(scope, primitive);
            return (
              <div
                key={ci}
                className={`relative h-14 rounded-sm overflow-hidden bg-white/5 border border-white/10 ${glowClass(pct)} group`}
                title={`${scope} × ${primitive}: ${pct}%`}
              >
                {/* Progress fill from bottom */}
                <div
                  className={`absolute bottom-0 left-0 right-0 transition-all duration-700 ${barColor(pct)}`}
                  style={{ height: `${pct}%` }}
                />
                {/* Percentage label */}
                {pct > 0 && (
                  <span className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-white/50 z-10">
                    {pct}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Legend — bottom right */}
      <div className="flex justify-end mt-3">
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-amber-500/90" />
            <span>75%+</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-amber-500/50" />
            <span>20-74%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-sm bg-white/5 border border-white/10" />
            <span>0%</span>
          </div>
          <span className="ml-2 text-white/30">Overall: {overall}%</span>
        </div>
      </div>
    </div>
  );
}
