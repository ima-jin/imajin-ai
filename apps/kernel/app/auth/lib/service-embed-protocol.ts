/**
 * RFC-19 (docs/rfcs/RFC-19-kernel-userspace-architecture.md, "postMessage
 * Protocol") — the typed message set exchanged between the hub shell and an
 * embedded service's iframe (#2275). `request_payment` is intentionally
 * excluded: it's listed in the RFC but out of scope for this issue.
 */
import type { ToastType } from '@imajin/ui';

export type KernelToAppMessage =
  | { type: 'session'; token: string }
  | { type: 'theme'; mode: 'light' | 'dark' }
  | { type: 'scope_revoked'; scope: string }
  | { type: 'unload' };

export type AppToKernelMessage =
  | { type: 'set_title'; title: string }
  | { type: 'set_badge'; count: number }
  | { type: 'navigate'; path: string }
  | { type: 'toast'; message: string; level?: ToastType };

const APP_TO_KERNEL_TYPES = new Set(['set_title', 'set_badge', 'navigate', 'toast']);
const TOAST_TYPES = new Set(['success', 'error', 'warning', 'info']);

/** Narrow an arbitrary `message` event payload down to a known App -> Kernel message. */
export function isAppToKernelMessage(data: unknown): data is AppToKernelMessage {
  if (typeof data !== 'object' || data === null) return false;
  const { type } = data as { type?: unknown };
  if (typeof type !== 'string' || !APP_TO_KERNEL_TYPES.has(type)) return false;

  const record = data as Record<string, unknown>;
  if (type === 'set_title') return typeof record.title === 'string';
  if (type === 'set_badge') return typeof record.count === 'number';
  if (type === 'navigate') return typeof record.path === 'string';
  return typeof record.message === 'string';
}

/** Clamp an arbitrary `level` down to a known toast type, defaulting to 'info'. */
export function normalizeToastLevel(level: unknown): ToastType {
  return typeof level === 'string' && TOAST_TYPES.has(level) ? (level as ToastType) : 'info';
}
