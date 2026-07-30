/**
 * Derives `PrimitiveMatrix` props from the raw `docs/matrix-status.json` shape.
 *
 * Shared by the homepage (`app/page.tsx`) and the project pitch page
 * (`app/project/page.tsx`) so the cells/overall computation lives in exactly
 * one place (dedup — SonarCloud "duplication on new code").
 */

interface MatrixStatusCell {
  percent: number;
}

export interface MatrixStatus {
  cells: Record<string, MatrixStatusCell>;
}

export interface MatrixProps {
  cells: Record<string, number>;
  overall: number;
}

export function toMatrixProps(data: MatrixStatus): MatrixProps {
  const entries = Object.entries(data.cells);
  const cells = Object.fromEntries(entries.map(([key, value]) => [key, value.percent]));
  const overall = Math.round(
    entries.reduce((sum, [, value]) => sum + value.percent, 0) / entries.length,
  );
  return { cells, overall };
}
