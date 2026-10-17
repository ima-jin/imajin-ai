import type { JsonValue } from '@imajin/bus';

export const LOOP_REDACTED = '[REDACTED]';
const SECRET_FIELD = /(?:password|passwd|secret|token|apikey|authorization|credential|privatekey|cookie|connectionstring)/i;

function redactPem(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let start = text.indexOf('-----BEGIN ');
  while (start >= 0) {
    parts.push(text.slice(cursor, start), LOOP_REDACTED);
    const end = text.indexOf('-----END ', start);
    const endMarker = end < 0 ? -1 : text.indexOf('-----', end + 9);
    // A partial PEM block can still contain key material: redact the remainder.
    if (endMarker < 0) return parts.join('');
    cursor = endMarker + 5;
    start = text.indexOf('-----BEGIN ', cursor);
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
function redactConnectionCredentials(word: string): string {
  const schemeEnd = word.indexOf('://');
  if (schemeEnd < 1) return word;
  const authorityStart = schemeEnd + 3;
  const authorityEnd = word.indexOf('/', authorityStart);
  const credentialEnd = word.indexOf('@', authorityStart);
  if (credentialEnd < 0 || (authorityEnd >= 0 && credentialEnd > authorityEnd)) return word;
  return `${word.slice(0, authorityStart)}${LOOP_REDACTED}${word.slice(credentialEnd)}`;
}

function redactAssignment(match: string, prefix: string, key: string): string {
  return SECRET_FIELD.test(key.replaceAll(/[^a-z0-9]/gi, '')) ? `${prefix}${LOOP_REDACTED}` : match;
}

function closingQuote(text: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (!escaped && char === quote) return index;
    escaped = !escaped && char === '\\';
  }
  return text.length;
}

function redactQuotedAssignments(text: string): string {
  const assignment = /\b([a-z_-]+)["']?\s*[:=]\s*(["'])/gi;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(text)) !== null) {
    if (!SECRET_FIELD.test(match[1].replaceAll(/[^a-z0-9]/gi, ''))) continue;
    const valueStart = assignment.lastIndex;
    const end = closingQuote(text, valueStart, match[2]);
    parts.push(text.slice(cursor, valueStart), LOOP_REDACTED);
    cursor = end;
    assignment.lastIndex = end + 1;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** Redact credential-shaped strings, including free text and external references. */
export function redactLoopText(text: string): string {
  return redactQuotedAssignments(redactPem(text))
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/-]+=*/gi, `$1 ${LOOP_REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, LOOP_REDACTED)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, LOOP_REDACTED)
    .replace(/\b[rs]k_(?:live|test)_[A-Za-z0-9]+/g, LOOP_REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, LOOP_REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}/g, LOOP_REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/g, LOOP_REDACTED)
    .replace(/[^\s"'<>]+/g, redactConnectionCredentials)
    .replace(/\b(([a-z_-]+)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, redactAssignment);
}

/** Input has already passed bounded JSON validation. Never mutate signed fields. */
export function redactLoopJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactLoopText(value);
  if (Array.isArray(value)) return value.map(redactLoopJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    redactLoopText(key),
    SECRET_FIELD.test(key.replaceAll(/[^a-z0-9]/gi, '')) ? LOOP_REDACTED : redactLoopJson(child),
  ]));
}
