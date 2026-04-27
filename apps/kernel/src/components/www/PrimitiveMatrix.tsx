'use client';

const SCOPES = ['Actor', 'Family', 'Community', 'Business'];
const PRIMITIVES = ['Attestation', 'Communication', 'Attribution', 'Settlement', 'Discovery'];
const SCOPE_ICONS = ['◆', '◇', '○', '□'];

function barBg(pct: number): string {
  if (pct === 0) return 'transparent';
  if (pct < 20) return 'rgba(245,158,11,0.3)';
  if (pct < 50) return 'rgba(245,158,11,0.5)';
  if (pct < 75) return 'rgba(245,158,11,0.7)';
  return 'rgba(245,158,11,0.9)';
}

function glowClass(pct: number): string {
  if (pct >= 75) return '';
  if (pct >= 50) return '';
  return '';
}

interface PrimitiveMatrixProps {
  cells: Record<string, number>;
  overall: number;
}

export function PrimitiveMatrix({ cells, overall }: PrimitiveMatrixProps) {
  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Column headers — vertical text */}
      <div
        className="grid gap-1 mb-2"
        style={{ gridTemplateColumns: `100px repeat(${PRIMITIVES.length}, 1fr)` }}
      >
        <div /> {/* empty corner */}
        {PRIMITIVES.map((col, ci) => (
          <div key={ci} className="flex justify-center h-20 text-primary/50">
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
          <div className="flex items-center gap-1.5 pr-2 text-primary/60">
            <span className="text-xs opacity-40">{SCOPE_ICONS[ri]}</span>
            <span className="text-xs font-medium">{scope}</span>
          </div>

          {/* Cells — horizontal fill left to right */}
          {PRIMITIVES.map((primitive, ci) => {
            const key = `${scope}×${primitive}`;
            const pct = cells[key] ?? 0;
            return (
              <div
                key={ci}
                className={`h-10 border border-white/10 ${glowClass(pct)}`}
                title={`${scope} × ${primitive}: ${pct}%`}
                style={{
                  background: pct > 0
                    ? `linear-gradient(to right, ${barBg(pct)} ${pct}%, rgba(255,255,255,0.03) ${pct}%)`
                    : 'rgba(255,255,255,0.03)',
                }}
              />
            );
          })}
        </div>
      ))}

      {/* Legend — bottom right, small */}
      <div className="flex justify-end mt-3">
        <div className="flex items-center gap-2 text-[10px] text-primary/40">
          <div className="w-2.5 h-2.5 bg-warning/80" />
          <span>{overall}% complete</span>
        </div>
      </div>
    </div>
  );
}
