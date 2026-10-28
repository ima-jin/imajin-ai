#!/usr/bin/env node
/**
 * Kernel/harness boundary ratchet (#3150, parent #2881).
 *
 * Scans production TS/JS under apps/kernel/{src,app}; comments and tests
 * are not code paths. Uses the existing TypeScript dependency to handle
 * multiline imports, dynamic imports, computed calls and URL literals without
 * mistaking signed refs.sessionKey / meet.transcript.available for calls.
 *
 * This is a static guard, not whole-program dataflow analysis: dynamically
 * constructed/obfuscated endpoints still require boundary review.
 *
 * Usage: node scripts/ci-guard-harness-boundary.mjs [--list]
 * CI_GUARD_WORKDIR overrides the repo root for isolated fixture tests.
 * --list reports all detections, including allowlisted ones, without failing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(process.env.CI_GUARD_WORKDIR ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const SCAN_ROOTS = ['apps/kernel/src', 'apps/kernel/app'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const EXCLUDED_DIRS = new Set(['__tests__', 'tests', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const KINDS = Object.freeze({
  PACKAGE: 'package-import',
  RPC: 'gateway-rpc',
  SURFACE: 'gateway-surface',
  STORE: 'harness-store',
  READ: 'harness-read',
});

// Exact (file, kind, value) exceptions only, never a whole directory/file.
// Ratchet: remove an entry when its legacy path goes away; do not add new calls.
export const ALLOWLIST = [
  {
    file: 'apps/kernel/app/warp/api/runs/[runId]/transcript/route.ts',
    kind: KINDS.READ, value: 'getAgentRunTranscript',
    reason: 'Pre-existing #1639 caller-key-authenticated Warp diagnosis route; runtime migration is outside #3150.',
  },
  {
    file: 'apps/kernel/src/lib/mcp/tools/warp.ts',
    kind: KINDS.READ, value: 'getAgentRunTranscript',
    reason: 'Pre-existing #1639 warp_get_transcript tool uses the caller sealed key; runtime migration is outside #3150.',
  },
  {
    file: 'apps/kernel/src/lib/warp/dispatch.ts',
    kind: KINDS.STORE, value: '/transcript',
    reason: 'Pre-existing #1639 Warp transcript HTTP client backs the authorized diagnosis route/tool.',
  },
  {
    file: 'apps/kernel/src/lib/warp/dispatch.ts',
    kind: KINDS.READ, value: 'readTranscript',
    reason: 'Pre-existing #1639 bounded response reader for the same Warp diagnosis client.',
  },
  {
    file: 'apps/kernel/src/lib/google/meet.ts',
    kind: KINDS.STORE, value: '/conferenceRecords/${value}/transcripts',
    reason: 'Google Meet conference transcript connector reads meeting content, not a harness transcript/session store.',
  },
];

export function validateAllowlist(entries) {
  const keys = new Set();
  for (const entry of entries) {
    if (!entry.file || !entry.kind || !entry.value || !entry.reason?.trim() || /[\r\n]/.test(entry.reason)) {
      throw new Error('Every harness-boundary allowlist entry needs file, kind, value and a one-line reason.');
    }
    const key = violationKey(entry);
    if (keys.has(key)) throw new Error(`Duplicate harness-boundary allowlist entry: ${entry.file}`);
    keys.add(key);
  }
  return keys;
}

function violationKey(entry) {
  return JSON.stringify([entry.file, entry.kind, entry.value]);
}

function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function literalText(node) {
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${value}${span.literal.text}`).join('');
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return null;
}

function memberName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${memberName(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) return `${memberName(node.expression)}.${literalText(node.argumentExpression) ?? ''}`;
  return '';
}

function forbiddenPackage(value) {
  const segments = value.toLowerCase().split('/');
  return segments.some((segment) => segment.includes('openclaw') || segment.includes('gateway-client') || segment.includes('gateway-sdk') || segment === 'gateway' || segment === '@gateway');
}

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || memberName(node.expression) === 'require')) {
    return node.arguments[0];
  }
  return undefined;
}

function rpcName(value) {
  return /^sessions_[a-z_]+$/i.test(value) || value === 'chat.history';
}

function literalKind(value) {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.includes('/tools/invoke')) return KINDS.SURFACE;
  if (/^wss?:\/\/gateway\b/i.test(value) || /^https?:\/\/gateway\b/i.test(value)) return KINDS.SURFACE;
  if (/^https?:\/\/openclaw\b/i.test(value) || /^wss?:\/\/openclaw\b/i.test(value)) return KINDS.SURFACE;
  if (/(?:^|:)18789\b/.test(value) || /(?:^|:)18790\b/.test(value)) return KINDS.SURFACE;
  if (normalized.includes('.openclaw/') || normalized.includes('.clawdbot/')) return KINDS.STORE;
  if (/(?:^|\/)sessions\.json\b/.test(normalized)) return KINDS.STORE;
  if (/(?:^|\/)sessions\/.*\.jsonl\b/.test(normalized)) return KINDS.STORE;
  if (/\/(?:transcripts?|session-store)(?:\/|$)/i.test(normalized)) return KINDS.STORE;
  return null;
}

function callKind(name) {
  const last = name.split('.').at(-1);
  if (rpcName(last) || name.endsWith('chat.history')) return KINDS.RPC;
  if (/^(?:read|get|load).*Transcript/i.test(last)) return KINDS.READ;
  if (/^(?:read|get|load).*SessionStore/i.test(last)) return KINDS.READ;
  if (name.endsWith('sessionStore.get') || name.endsWith('sessionStore.read')) return KINDS.READ;
  if (/^(?:gateway|gatewayClient|openclaw)\./i.test(name)) return KINDS.RPC;
  return null;
}

function scanFile(filePath) {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const file = relative(ROOT, filePath).replaceAll('\\', '/');
  const violations = [];
  const add = (node, kind, value) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ file, line: line + 1, kind, value });
  };
  function visit(node) {
    const specifier = moduleSpecifier(node);
    const imported = specifier && literalText(specifier);
    if (imported && forbiddenPackage(imported)) add(node, KINDS.PACKAGE, imported);

    if (ts.isCallExpression(node)) {
      const name = memberName(node.expression);
      const kind = callKind(name);
      if (kind) add(node, kind, name);
    }

    const value = literalText(node);
    const kind = value && literalKind(value);
    if (kind) add(node, kind, value);
    if (value && rpcName(value)) add(node, KINDS.RPC, value);
    if (ts.isNumericLiteral(node) && ['18789', '18790'].includes(node.text)) {
      add(node, KINDS.SURFACE, node.text);
    }
    if (ts.isIdentifier(node) && /^(?:OPENCLAW_)?GATEWAY_(?:URL|HOST|PORT)$/.test(node.text)) {
      add(node, KINDS.SURFACE, node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

function main() {
  const allowed = validateAllowlist(ALLOWLIST);
  const violations = SCAN_ROOTS.flatMap((dir) => listSourceFiles(join(ROOT, dir))).flatMap(scanFile);
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  if (process.argv.includes('--list')) {
    console.log(JSON.stringify(violations, null, 2));
    return;
  }
  const unexpected = violations.filter((entry) => !allowed.has(violationKey(entry)));
  if (unexpected.length > 0) {
    console.error(`FAIL: ${unexpected.length} kernel harness-boundary violation(s):`);
    for (const entry of unexpected) {
      console.error(`  ${entry.file}:${entry.line}: ${entry.kind} (${entry.value})`);
    }
    console.error('The kernel consumes signed facts, not gateway calls, harness transcripts or session stores.');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: kernel harness boundary (${violations.length} allowlisted detections).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`ci-guard-harness-boundary: ${error.message}`);
    process.exitCode = 1;
  }
}
