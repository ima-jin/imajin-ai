#!/usr/bin/env node
// scripts/build-matrix.mjs
// Content matrix generator — walks docs/articles/ and docs/rfcs/,
// parses frontmatter, validates it, and emits cross-referenced index files.

import { globSync } from 'fs';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, basename, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// ── Schema ──────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['title', 'type'];
const ALLOWED_TYPES = ['essay', 'rfc', 'adr'];
const ALLOWED_STATUSES = ['draft', 'shipped', 'superseded'];
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'title', 'type', 'status', 'rev', 'date', 'author', 'slug', 'topics', 'refs', 'subtitle', 'description', 'update'
]);
const ALLOWED_REFS_KEYS = new Set(['rfcs', 'issues', 'prs', 'packages', 'essays', 'external']);

// ── Helpers ─────────────────────────────────────────────────────────

function die(msg) {
  console.error('Error:', msg);
  process.exit(1);
}

function validate(artifact) {
  const { path } = artifact;
  const data = artifact;
  const errors = [];

  for (const key of REQUIRED_FIELDS) {
    if (data[key] == null) errors.push(`${path}: missing required field "${key}"`);
  }

  if (data.type != null && !ALLOWED_TYPES.includes(data.type)) {
    errors.push(`${path}: invalid type "${data.type}" — must be one of ${ALLOWED_TYPES.join(', ')}`);
  }

  if (data.status != null && !ALLOWED_STATUSES.includes(data.status)) {
    errors.push(`${path}: invalid status "${data.status}" — must be one of ${ALLOWED_STATUSES.join(', ')}`);
  }

  if (data.type === 'essay' && data.status === 'posted') {
    // normalize for validation — we'll warn but accept
    // (backfill should have fixed this)
  }

  if (data.rev != null && typeof data.rev !== 'number') {
    errors.push(`${path}: rev must be a number, got ${typeof data.rev}`);
  }

  if (data.topics != null && !Array.isArray(data.topics)) {
    errors.push(`${path}: topics must be an array`);
  }

  // Check for unknown top-level keys (skip internal fields like 'path')
  for (const key of Object.keys(data)) {
    if (key === 'path') continue;
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${path}: unknown frontmatter key "${key}"`);
    }
  }

  // Check refs sub-keys
  if (data.refs != null) {
    if (typeof data.refs !== 'object' || Array.isArray(data.refs)) {
      errors.push(`${path}: refs must be an object`);
    } else {
      for (const key of Object.keys(data.refs)) {
        if (!ALLOWED_REFS_KEYS.has(key)) {
          errors.push(`${path}: unknown refs key "${key}"`);
        }
      }
      for (const key of ['rfcs', 'issues', 'prs', 'packages', 'essays']) {
        if (data.refs[key] != null && !Array.isArray(data.refs[key])) {
          errors.push(`${path}: refs.${key} must be an array`);
        }
      }
      if (data.refs.external != null) {
        if (!Array.isArray(data.refs.external)) {
          errors.push(`${path}: refs.external must be an array`);
        } else {
          for (const item of data.refs.external) {
            if (typeof item !== 'object' || !item.url) {
              errors.push(`${path}: refs.external items must have a "url" property`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    die(`validation failed for ${path} (${errors.length} error${errors.length > 1 ? 's' : ''})`);
  }
}

function slugFromPath(p) {
  const name = basename(p, extname(p));
  return name;
}

function walk() {
  const articles = globSync('docs/articles/*.md', { cwd: ROOT })
    .filter(p => !basename(p).startsWith('INDEX') && !basename(p).startsWith('MATRIX'));
  const rfcs = globSync('docs/rfcs/**/*.md', { cwd: ROOT })
    .filter(p => basename(p) !== 'INDEX.md');
  return [...articles, ...rfcs].map(p => ({
    absolute: p,
    path: p,
  }));
}

function parse(files) {
  const artifacts = [];
  for (const file of files) {
    const raw = readFileSync(file.absolute, 'utf-8');
    const parsed = matter(raw);
    const slug = parsed.data.slug || slugFromPath(file.path);
    const artifact = {
      path: file.path,
      slug,
      title: parsed.data.title || slug,
      type: parsed.data.type,
      status: parsed.data.status || 'draft',
      rev: parsed.data.rev ?? null,
      date: parsed.data.date || null,
      author: parsed.data.author || null,
      topics: parsed.data.topics || [],
      refs: parsed.data.refs || {},
      // Preserve extra fields that are allowed
      subtitle: parsed.data.subtitle || null,
      description: parsed.data.description || null,
      update: parsed.data.update || null,
    };
    validate(artifact);
    artifacts.push(artifact);
  }
  return artifacts;
}

// ── Emitters ────────────────────────────────────────────────────────

const HEADER = '<!-- AUTO-GENERATED by scripts/build-matrix.mjs — DO NOT EDIT -->';

function emitMatrix(artifacts) {
  // Group by topic
  const topicMap = new Map(); // topic -> { essays: Set, rfcs: Set, issues: Set, prs: Set, packages: Set }
  for (const a of artifacts) {
    const topics = a.topics.length > 0 ? a.topics : ['(untagged)'];
    for (const t of topics) {
      if (!topicMap.has(t)) {
        topicMap.set(t, { essays: new Set(), rfcs: new Set(), issues: new Set(), prs: new Set(), packages: new Set() });
      }
      const entry = topicMap.get(t);
      const relPath = a.path.replace(/^docs\//, './');
      if (a.type === 'essay') entry.essays.add(`[${a.title}](${relPath})`);
      if (a.type === 'rfc') entry.rfcs.add(`[${a.title}](${relPath})`);
      for (const n of (a.refs.issues || [])) entry.issues.add(`#${n}`);
      for (const n of (a.refs.prs || [])) entry.prs.add(`#${n}`);
      for (const pkg of (a.refs.packages || [])) entry.packages.add(pkg);
    }
  }

  // Sort topics alphabetically, but put (untagged) last
  const topics = Array.from(topicMap.keys()).sort((a, b) => {
    if (a === '(untagged)') return 1;
    if (b === '(untagged)') return -1;
    return a.localeCompare(b);
  });

  const lines = [
    HEADER,
    '',
    '# Content Matrix',
    '',
    'Topic-grouped view of all essays, RFCs, and their cross-references.',
    '',
    '| Topic | Essays | RFCs | Issues | PRs | Packages |',
    '|-------|--------|------|--------|-----|----------|',
  ];

  for (const t of topics) {
    const e = topicMap.get(t);
    const essays = Array.from(e.essays).sort().join(', ') || '—';
    const rfcs = Array.from(e.rfcs).sort().join(', ') || '—';
    const issues = Array.from(e.issues).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).join(', ') || '—';
    const prs = Array.from(e.prs).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).join(', ') || '—';
    const packages = Array.from(e.packages).sort().join(', ') || '—';
    lines.push(`| **${t}** | ${essays} | ${rfcs} | ${issues} | ${prs} | ${packages} |`);
  }

  lines.push('');

  writeFileSync(`${ROOT}/docs/MATRIX.md`, lines.join('\n'));
  console.log('  → docs/MATRIX.md');
}

function emitIndex(artifacts) {
  // Sort alphabetically by slug
  const sorted = [...artifacts].sort((a, b) => a.slug.localeCompare(b.slug));

  const lines = [
    HEADER,
    '',
    '# Content Index',
    '',
    'Alphabetical list of all documented artifacts.',
    '',
  ];

  for (const a of sorted) {
    const statusBadge = a.status === 'shipped' ? '✅' : a.status === 'superseded' ? '⛔' : '📝';
    lines.push(`## ${a.slug}`);
    lines.push('');
    lines.push(`- **Title:** ${a.title}`);
    lines.push(`- **Type:** ${a.type}`);
    lines.push(`- **Status:** ${statusBadge} ${a.status}`);
    if (a.rev != null) lines.push(`- **Rev:** ${a.rev}`);
    if (a.date) lines.push(`- **Date:** ${a.date}`);
    if (a.author) lines.push(`- **Author:** ${a.author}`);
    lines.push(`- **Path:** [${a.path}](./${a.path.replace(/^docs\//, '')})`);
    if (a.topics.length > 0) lines.push(`- **Topics:** ${a.topics.join(', ')}`);

    const refLines = [];
    if (a.refs.rfcs?.length) refLines.push(`  - RFCs: ${a.refs.rfcs.map(n => `[RFC-${String(n).padStart(2, '0')}](./rfcs/RFC-${String(n).padStart(2, '0')}-*)`).join(', ')}`);
    if (a.refs.issues?.length) refLines.push(`  - Issues: ${a.refs.issues.map(n => `#${n}`).join(', ')}`);
    if (a.refs.prs?.length) refLines.push(`  - PRs: ${a.refs.prs.map(n => `#${n}`).join(', ')}`);
    if (a.refs.packages?.length) refLines.push(`  - Packages: ${a.refs.packages.join(', ')}`);
    if (a.refs.essays?.length) refLines.push(`  - Essays: ${a.refs.essays.map(s => `[${s}](./articles/${s}.md)`).join(', ')}`);
    if (a.refs.external?.length) refLines.push(`  - External: ${a.refs.external.map(e => `[${e.title || e.url}](${e.url})`).join(', ')}`);

    if (refLines.length > 0) {
      lines.push('- **Refs:**');
      lines.push(...refLines);
    }
    lines.push('');
  }

  lines.push('');

  writeFileSync(`${ROOT}/docs/INDEX.md`, lines.join('\n'));
  console.log('  → docs/INDEX.md');
}

function emitJson(artifacts) {
  const graph = {
    artifacts: artifacts.map(a => ({
      slug: a.slug,
      title: a.title,
      type: a.type,
      status: a.status,
      rev: a.rev,
      date: a.date,
      author: a.author,
      path: a.path,
      topics: a.topics,
      refs: a.refs,
    })),
  };

  // Build topic → artifacts index
  const topicIndex = {};
  for (const a of artifacts) {
    const topics = a.topics.length > 0 ? a.topics : [];
    for (const t of topics) {
      if (!topicIndex[t]) topicIndex[t] = [];
      topicIndex[t].push(a.slug);
    }
  }
  graph.topics = topicIndex;

  writeFileSync(`${ROOT}/docs/.matrix.json`, JSON.stringify(graph, null, 2) + '\n');
  console.log('  → docs/.matrix.json');
}

// ── Main ────────────────────────────────────────────────────────────

console.log('Building content matrix...');
const files = walk();
console.log(`Found ${files.length} files`);

const artifacts = parse(files);
console.log(`Parsed & validated ${artifacts.length} artifacts`);

emitMatrix(artifacts);
emitIndex(artifacts);
emitJson(artifacts);

console.log('Done.');
