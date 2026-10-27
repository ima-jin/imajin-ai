import type { LoopEventJson } from './serialize';
import { SURFACE_LEASE_TTL_MS } from './surface-lease-policy';
import { isSurfaceUri } from './types';

export interface StepLeaseWindow {
  holderDid: string;
  acquiredAt: number;
  endsAt: number;
}

/** Input is verified history scoped to one loop/principal, never the live lease table. */
export function stepLeaseWindows(events: LoopEventJson[]): Map<string, StepLeaseWindow[]> {
  const windows = new Map<string, StepLeaseWindow[]>();
  const current = new Map<string, StepLeaseWindow>();
  const transitions = events.filter(event => ['surface.acquired', 'surface.released', 'loop.finished'].includes(event.type))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
      // A release/completion ends authority at its timestamp, regardless of signed-id order.
      || Number(a.type !== 'surface.acquired') - Number(b.type !== 'surface.acquired')
      || a.id.localeCompare(b.id));
  for (const event of transitions) {
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at)) continue;
    if (event.type === 'loop.finished') {
      for (const window of current.values()) endHolding(window, event.issuer, at);
      continue;
    }
    const surface = event.payload.surface;
    if (!isSurfaceUri(surface) || !surface.startsWith('step:')) continue;
    if (event.type === 'surface.released') {
      endHolding(current.get(surface), event.issuer, at);
    } else {
      acquire(windows, current, surface, event, at);
    }
  }
  return windows;
}

function endHolding(window: StepLeaseWindow | undefined, issuer: string, at: number): void {
  if (window?.holderDid === issuer) window.endsAt = Math.min(window.endsAt, at);
}

function acquire(
  windows: Map<string, StepLeaseWindow[]>, current: Map<string, StepLeaseWindow>,
  surface: string, event: LoopEventJson, at: number,
): void {
  // Server-assigned collision metadata survives retries and cross-loop/principal conflicts.
  // A warned contender's signed acquisition is history, not a granted lease.
  if (event.payload.observedConflictingLoopId) return;
  const holding = current.get(surface);
  if (holding && at < holding.endsAt) {
    if (holding.holderDid === event.issuer) holding.endsAt = at + SURFACE_LEASE_TTL_MS;
    return;
  }
  const window = { holderDid: event.issuer, acquiredAt: at, endsAt: at + SURFACE_LEASE_TTL_MS };
  current.set(surface, window);
  const history = windows.get(surface) ?? [];
  history.push(window);
  windows.set(surface, history);
}
