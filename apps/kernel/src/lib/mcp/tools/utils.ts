/**
 * Shared argument-parsing and response helpers for MCP tools.
 *
 * All MCP tool files import from here instead of defining local copies,
 * eliminating per-file duplication.
 */
import type { McpContent } from '../types';

/** Extract a non-empty string from tool args, or undefined. */
export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Extract a number from tool args, or undefined. */
export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

/** Wrap a JSON-serialisable value as an MCP text content array. */
export function json(value: unknown): McpContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
