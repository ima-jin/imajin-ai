import type { LoopOutput } from '@imajin/bus';

export const MAX_LOOP_JSON_DEPTH = 24;
export const MAX_LOOP_JSON_NODES = 20000;
export const MAX_LOOP_METADATA_BYTES = 16384;

/** Excludes output, which has its own inline/artifact budget. */
export function isWithinLoopMetadataBudget(payload: Record<string, unknown>): boolean {
  const metadata = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'output'));
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_LOOP_METADATA_BYTES;
}

/** Reject non-JSON, cycles, extreme depth and enormous collections before traversing again. */
export function isBoundedLoopJson(value: unknown): boolean {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_LOOP_JSON_NODES || depth > MAX_LOOP_JSON_DEPTH) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) return false;
    ancestors.add(item);
    const valid = Object.values(item).every(child => visit(child, depth + 1));
    ancestors.delete(item);
    return valid;
  }
  return visit(value, 0);
}

const OUTPUT_FIELDS: Record<LoopOutput['kind'], { required: string[]; optional: string[] }> = {
  text: { required: ['text'], optional: ['role'] },
  tool_call: { required: ['callId', 'name', 'args'], optional: [] },
  tool_result: { required: ['callId', 'result'], optional: ['isError'] },
  artifact: { required: ['ref'], optional: ['name', 'mediaType'] },
  decision: { required: ['decision'], optional: ['reason'] },
  approval_request: { required: ['approvalId', 'action'], optional: ['details'] },
  spawn: { required: ['loopId'], optional: ['principal'] },
  model_change: { required: ['model'], optional: ['previousModel', 'provider'] },
};
const JSON_FIELDS = new Set(['args', 'result', 'details']);

function isOutputField(key: string, value: unknown): boolean {
  if (JSON_FIELDS.has(key)) return isBoundedLoopJson(value);
  if (key === 'isError') return typeof value === 'boolean';
  return typeof value === 'string';
}

/** Only publisher shapes: storage wrappers and cross-kind fields are never accepted. */
export function isLoopOutput(raw: unknown): raw is LoopOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const output = raw as Record<string, unknown>;
  if (typeof output.kind !== 'string' || !Object.hasOwn(OUTPUT_FIELDS, output.kind)) return false;
  const fields = OUTPUT_FIELDS[output.kind as LoopOutput['kind']];
  if (!fields.required.every(key => Object.hasOwn(output, key))) return false;
  return Object.entries(output).every(([key, value]) =>
    key === 'kind' || ((fields.required.includes(key) || fields.optional.includes(key)) && isOutputField(key, value)),
  );
}
