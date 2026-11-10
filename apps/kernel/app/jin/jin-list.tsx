import type { ReactNode } from 'react';

/** Shared read-only list and paging controls from the Record lane. */
export function JinList({ children }: Readonly<{ children: ReactNode }>) {
  return <ul className="space-y-3 min-w-0">{children}</ul>;
}

export function JinListPages({ label, offset, hasMore, onOffset, newer, older, children }: Readonly<{
  label: string; offset: number; hasMore: boolean; onOffset: (offset: number) => void;
  newer: string; older: string; children?: ReactNode;
}>) {
  return <nav aria-label={label} className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-400">
    <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - 50))}
      className="min-h-11 px-2 disabled:opacity-40">{newer}</button>
    {children}
    <button type="button" disabled={!hasMore} onClick={() => onOffset(offset + 50)}
      className="min-h-11 px-2 disabled:opacity-40">{older}</button>
  </nav>;
}
