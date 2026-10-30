import { Buffer } from 'node:buffer';
import { WarpBriefSizeError } from './errors';

/**
 * 1 MiB: >3x the largest HTTP corpus prefix (100,000 UTF-16 units,
 * <=300,003 UTF-8 bytes), separator (7 bytes) and observed brief (12,212 bytes).
 * MCP may request larger corpus blocks; the final composed bytes still obey this cap.
 */
export const WARP_BRIEF_MAX_BYTES = 1024 * 1024;

export function isWarpBriefTooLarge(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > WARP_BRIEF_MAX_BYTES;
}

/** Validate without modifying the exact bytes the ledger and provider receive. */
export function assertWarpBriefSize(text: string): void {
  if (isWarpBriefTooLarge(text)) throw new WarpBriefSizeError(WARP_BRIEF_MAX_BYTES);
}
