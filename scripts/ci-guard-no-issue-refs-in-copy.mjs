#!/usr/bin/env node
// Keep GitHub issue references out of product copy. Comments/history are not copy.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPY_FIELDS = new Set(['description', 'label', 'title', 'message', 'error', 'reason']);
const COPY_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage',
  '__tests__', 'tests', 'test', 'api-spec', 'migrations',
]);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function fieldName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return node.argumentExpression?.text;
  return node?.text;
}

function isCopyAssignment(node) {
  if (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) {
    return COPY_FIELDS.has(fieldName(node.name));
  }
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && COPY_FIELDS.has(fieldName(node.left));
}

function isCopyCall(node) {
  if (ts.isNewExpression(node)) return node.expression.getText() === 'Error';
  return ts.isCallExpression(node) && node.expression.getText() === 'NextResponse.json';
}

function isCopySink(node) {
  if (ts.isJsxText(node)) return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return COPY_ATTRIBUTES.has(fieldName(parent.name));
    if (ts.isJsxExpression(parent)) {
      return !ts.isJsxAttribute(parent.parent) || COPY_ATTRIBUTES.has(fieldName(parent.parent.name));
    }
    if (isCopyAssignment(parent) || isCopyCall(parent)) return true;
    if (ts.isStatement(parent)) break;
  }
  return false;
}

function hasIssueReference(text) {
  return /imajin-ai#\d+|#\d{3,5}\b/.test(text);
}
function isColorValue(node) {
  return ts.isPropertyAssignment(node.parent)
    && /color|background|border|fill|stroke/i.test(fieldName(node.parent.name) ?? '')
    && /^#[\da-f]{3,8}$/i.test(node.text);
}

function allowedLines(sourceFile) {
  const lines = new Set();
  function collect(ranges) {
    for (const range of ranges ?? []) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const comment = sourceFile.text.slice(range.pos, range.end);
      if (/^\/\/ copy-allow-issue-ref: \S.*$/.test(comment)) {
        lines.add(sourceFile.getLineAndCharacterOfPosition(range.pos).line);
      }
    }
  }
  function visit(node) {
    collect(ts.getLeadingCommentRanges(sourceFile.text, node.pos));
    collect(ts.getTrailingCommentRanges(sourceFile.text, node.end));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return lines;
}

/** Parse executable source: comments and property names are never copy nodes. */
export function scanSource(source, file = 'fixture.tsx') {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const allowed = allowedLines(sourceFile);
  const hits = [];
  function record(node) {
    const start = ts.isJsxText(node) ? node.pos : node.getStart(sourceFile);
    const firstLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    node.text.split('\n').forEach((text, offset) => {
      const line = firstLine + offset;
      if (hasIssueReference(text) && !allowed.has(line)) hits.push({ file, line: line + 1, text: text.trim() });
    });
  }
  function visit(node) {
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    const isKey = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    if (literal && !isKey && !isColorValue(node) && isCopySink(node)) record(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return hits;
}

export function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) files.push(...listSourceFiles(full));
    if (entry.isFile() && EXTENSIONS.has(extname(entry.name))
      && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function loadAllowlist(root) {
  const path = join(root, 'scripts/copy-issue-ref-allowlist.json');
  if (!existsSync(path)) return new Set();
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('Copy allowlist must be an array');
  for (const entry of entries) {
    if (!entry || !/^apps\/kernel\/src\/lib\/mcp\/tools\/[\w-]+\.ts$/.test(entry.file)
      || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error('Copy allowlist entries require an exact MCP tool file and a non-empty reason');
    }
  }
  return new Set(entries.map(entry => entry.file));
}

export function scanRepo(root = ROOT) {
  const allowlist = loadAllowlist(root);
  const hits = [];
  for (const dir of ['apps', 'packages']) {
    for (const file of listSourceFiles(join(root, dir))) {
      const name = relative(root, file).replaceAll('\\', '/');
      if (!allowlist.has(name)) hits.push(...scanSource(readFileSync(file, 'utf8'), name));
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function main(root = process.env.CI_GUARD_WORKDIR ?? ROOT) {
  const hits = scanRepo(resolve(root));
  if (process.argv.includes('--list')) {
    console.log(JSON.stringify(hits, null, 2));
    return 0;
  }
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: issue reference in product copy: ${hit.text}`);
  console.log(hits.length ? `FAIL: ${hits.length} product-copy issue references.` : 'PASS: no issue references in product copy.');
  return hits.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ci-guard-no-issue-refs-in-copy: ${error.message}`);
    process.exitCode = 1;
  }
}
