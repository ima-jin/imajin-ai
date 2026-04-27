#!/usr/bin/env node
// scripts/backfill-matrix-frontmatter.mjs
// Surgically backfills frontmatter on all docs/articles/*.md and docs/rfcs/**/*.md
// per the convention defined in docs/CONVENTIONS.md.

import { readFileSync, writeFileSync } from 'fs';
import { basename, extname } from 'path';
import matter from 'gray-matter';

// ── Topic keyword map ───────────────────────────────────────────────
const TOPIC_MAP = [
  { topic: 'legibility', keywords: ['legibility', 'receipt', 'transparent', 'opacity', 'visible', 'disclosure', 'accounting'] },
  { topic: 'fair', keywords: ['.fair', 'attribution', 'manifest', 'honor the chain', 'creative labor', 'copyright'] },
  { topic: 'identity', keywords: ['identity', 'did:', 'portable identity', 'backup node', 'sso', 'authentication', 'login'] },
  { topic: 'agents', keywords: ['agent', 'jin', 'presence', 'workspace agent', 'ai ', 'artificial intelligence'] },
  { topic: 'dfos', keywords: ['dfos', 'chain entry', 'attestation', 'proof of state', 'hrpos'] },
  { topic: 'settlement', keywords: ['settlement', 'payment', 'fee', 'token', 'mjn', 'economics', 'stripe', 'solana', 'currency'] },
  { topic: 'governance', keywords: ['governance', 'vote', 'decision', 'primitive', 'trust graph'] },
  { topic: 'events', keywords: ['event', 'ticket', 'party', 'ticketing', 'venue', 'rsvp'] },
  { topic: 'federation', keywords: ['federation', 'federated', 'handle', 'fediverse', 'activitypub', 'bluesky', 'at protocol'] },
  { topic: 'sovereignty', keywords: ['sovereign', 'sovereignty', 'own your', 'user data', 'privacy', 'self-hosted'] },
];

function guessTopics(text, title) {
  const combined = (text + ' ' + title).toLowerCase();
  const topics = [];
  for (const { topic, keywords } of TOPIC_MAP) {
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        topics.push(topic);
        break;
      }
    }
  }
  return [...new Set(topics)];
}

// ── Essay refs extraction ───────────────────────────────────────────
function extractEssayRefs(text) {
  const refs = [];
  // Match markdown links to essay files or imajin.ai/articles/
  const patterns = [
    /\[.*?\]\((?:https:\/\/github\.com\/ima-jin\/imajin-ai\/blob\/main\/docs\/articles\/)?([^/\)]+\.md)\)/g,
    /\[.*?\]\(https:\/\/www\.imajin\.ai\/articles\/([^\)]+)\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let slug = m[1].replace(/\.md$/, '');
      // normalize: essay-31-the-receipt.md -> essay-31-the-receipt
      refs.push(slug);
    }
  }
  return [...new Set(refs)];
}

// ── RFC refs extraction ─────────────────────────────────────────────
function extractRfcRefs(text) {
  const refs = [];
  const re = /RFC[-\s]?(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) refs.push(n);
  }
  return [...new Set(refs)];
}

function extractIssueRefs(text) {
  const refs = [];
  const re = /(?:^|[\s\(])#(\d{2,})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > 10) refs.push(n); // avoid #1, #2 etc that might be list markers
  }
  return [...new Set(refs)];
}

function extractPrRefs(text) {
  // PRs are harder; look for explicit PR references
  const refs = [];
  const re = /(?:PR|pull request)[\s#-]*(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) refs.push(n);
  }
  return [...new Set(refs)];
}

function extractPackageRefs(text) {
  const refs = [];
  const re = /`@imajin\/([^`]+)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push(`@imajin/${m[1]}`);
  }
  return [...new Set(refs)];
}

// ── Status normalization ────────────────────────────────────────────
function normalizeStatus(status) {
  if (!status) return 'draft';
  const s = String(status).toLowerCase().trim();
  if (s.includes('posted')) return 'shipped';
  if (s.includes('review')) return 'draft';
  if (s.includes('stub')) return 'draft';
  if (s.includes('draft')) return 'draft';
  if (s.includes('shipped')) return 'shipped';
  if (s.includes('superseded')) return 'superseded';
  return 'draft';
}

function extractRev(status) {
  if (!status) return null;
  const m = String(status).match(/rev\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ── Inline header parsing for RFCs ──────────────────────────────────
function parseRfcInlineHeaders(text) {
  const lines = text.split('\n');
  const headers = {};
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\*\*(\w+):?\*\*\s*(.+)$/);
    if (m) {
      const key = m[1].toLowerCase().replace(/:$/, '');
      const value = m[2].trim();
      headers[key] = value;
      headerEnd = i + 1;
    } else if (line.trim() === '---') {
      headerEnd = i + 1;
      break;
    } else if (line.startsWith('## ')) {
      headerEnd = i;
      break;
    }
  }
  return { headers, headerEnd };
}

// ── YAML serialization helper ───────────────────────────────────────
function toYamlValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    if (v.includes(':') || v.includes('#') || v.includes('\'') || v.includes('"') || v.includes('\n')) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '\n' + v.map(item => {
      const s = toYamlValue(item);
      // Quote strings that need it (starting with @, containing :, etc.)
      if (typeof item === 'string' && (item.startsWith('@') || item.includes(':') || item.includes('#'))) {
        return `  - ${JSON.stringify(item)}`;
      }
      return `  - ${s}`;
    }).join('\n');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, val]) => val != null && (Array.isArray(val) ? val.length > 0 : true));
    if (entries.length === 0) return '';
    return '\n' + entries.map(([k, val]) => {
      const yv = toYamlValue(val);
      if (yv.startsWith('\n')) return `  ${k}:${yv}`;
      return `  ${k}: ${yv}`;
    }).join('\n');
  }
  return String(v);
}

function buildFrontmatter(data) {
  const lines = ['---'];
  const order = ['title', 'type', 'status', 'rev', 'date', 'author', 'slug', 'topics', 'refs', 'subtitle', 'description', 'update'];
  for (const key of order) {
    if (key in data && data[key] != null) {
      const val = toYamlValue(data[key]);
      if (val === '') continue;
      if (val.startsWith('\n')) {
        lines.push(`${key}:${val}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ── Process essays ──────────────────────────────────────────────────
function processEssay(filePath, raw) {
  const parsed = matter(raw);
  const slug = basename(filePath, extname(filePath));
  const body = parsed.content;

  let data = { ...parsed.data };

  // If already has frontmatter with type: essay, just rebuild (idempotent)
  if (data.type === 'essay') {
    const rev = data.rev || null;
    const newData = {
      title: data.title,
      type: 'essay',
      status: normalizeStatus(data.status),
      ...(rev != null ? { rev } : {}),
      ...(data.date ? { date: data.date } : {}),
      ...(data.author ? { author: data.author } : {}),
      slug: data.slug || slug,
      ...(data.topics?.length ? { topics: data.topics } : {}),
      ...(data.refs && Object.keys(data.refs).length ? { refs: data.refs } : {}),
      ...(data.subtitle ? { subtitle: data.subtitle } : {}),
      ...(data.description ? { description: data.description } : {}),
      ...(data.update ? { update: data.update } : {}),
    };
    return buildFrontmatter(newData) + body.trimStart();
  }

  // Normalize status
  const normalizedStatus = normalizeStatus(data.status);
  const rev = extractRev(data.status) || data.rev || null;

  // Determine title
  let title = data.title;
  if (!title) {
    // Try first h1
    const h1Match = body.match(/^#\s+(.+)$/m);
    title = h1Match ? h1Match[1].trim() : slug;
  }

  // Guess topics from body
  const topics = guessTopics(body, title);

  // Extract refs
  const essayRefs = extractEssayRefs(body);
  const rfcRefs = extractRfcRefs(body);
  const issueRefs = extractIssueRefs(body);
  const prRefs = extractPrRefs(body);
  const pkgRefs = extractPackageRefs(body);

  const refs = {};
  if (rfcRefs.length) refs.rfcs = rfcRefs;
  if (issueRefs.length) refs.issues = issueRefs;
  if (prRefs.length) refs.prs = prRefs;
  if (pkgRefs.length) refs.packages = pkgRefs;
  if (essayRefs.length) refs.essays = essayRefs;

  const newData = {
    title,
    type: 'essay',
    status: normalizedStatus,
    ...(rev != null ? { rev } : {}),
    ...(data.date ? { date: data.date } : {}),
    ...(data.author ? { author: data.author } : {}),
    slug,
    ...(topics.length ? { topics } : {}),
    ...(Object.keys(refs).length ? { refs } : {}),
    ...(data.subtitle ? { subtitle: data.subtitle } : {}),
    ...(data.description ? { description: data.description } : {}),
    ...(data.update ? { update: data.update } : {}),
  };

  return buildFrontmatter(newData) + body.trimStart();
}

// ── Process RFCs ────────────────────────────────────────────────────
function processRfc(filePath, raw) {
  const parsed = matter(raw);
  // If already has frontmatter, just rebuild it (idempotent)
  if (Object.keys(parsed.data).length > 0 && parsed.data.type === 'rfc') {
    const data = { ...parsed.data };
    const body = parsed.content;
    const newData = {
      title: data.title,
      type: 'rfc',
      status: normalizeStatus(data.status),
      ...(data.date ? { date: data.date } : {}),
      ...(data.author ? { author: data.author } : {}),
      slug: data.slug || basename(filePath, extname(filePath)),
      ...(data.topics?.length ? { topics: data.topics } : {}),
      ...(data.refs && Object.keys(data.refs).length ? { refs: data.refs } : {}),
    };
    return buildFrontmatter(newData) + body;
  }

  const slug = basename(filePath, extname(filePath));
  const { headers, headerEnd } = parseRfcInlineHeaders(raw);
  const body = raw;

  // Parse title from first h1
  const h1Match = body.match(/^#\s+(.+)$/m);
  let title = h1Match ? h1Match[1].trim() : slug;
  // Clean up "RFC-NN: Title" or "RFC: Title" prefix
  title = title.replace(/^RFC-\d+[:\s-]+/i, '').replace(/^RFC[:\s-]+/i, '').trim();

  const status = normalizeStatus(headers.status || headers.state);
  const author = headers.authors || headers.author || null;
  const date = headers.created || headers.date || null;

  // Guess topics
  const topics = guessTopics(body, title);

  // Extract refs
  const rfcRefs = extractRfcRefs(body);
  // Remove self-reference
  const selfNum = parseInt(slug.match(/RFC-(\d+)/i)?.[1] || '0', 10);
  const filteredRfcRefs = rfcRefs.filter(n => n !== selfNum);

  const issueRefs = extractIssueRefs(body);
  const prRefs = extractPrRefs(body);
  const pkgRefs = extractPackageRefs(body);

  const refs = {};
  if (filteredRfcRefs.length) refs.rfcs = filteredRfcRefs;
  if (issueRefs.length) refs.issues = issueRefs;
  if (prRefs.length) refs.prs = prRefs;
  if (pkgRefs.length) refs.packages = pkgRefs;

  const newData = {
    title,
    type: 'rfc',
    status,
    ...(date ? { date } : {}),
    ...(author ? { author } : {}),
    slug,
    ...(topics.length ? { topics } : {}),
    ...(Object.keys(refs).length ? { refs } : {}),
  };

  const fm = buildFrontmatter(newData);
  return fm + body;
}

// ── Main ────────────────────────────────────────────────────────────
import { globSync } from 'fs';

const essayFiles = globSync('docs/articles/*.md', { cwd: process.cwd() })
  .filter(p => !basename(p).startsWith('INDEX') && !basename(p).startsWith('MATRIX'));
const rfcFiles = globSync('docs/rfcs/**/*.md', { cwd: process.cwd() })
  .filter(p => basename(p) !== 'INDEX.md');

console.log(`Processing ${essayFiles.length} essays and ${rfcFiles.length} RFCs...`);

for (const f of essayFiles) {
  const raw = readFileSync(f, 'utf-8');
  const updated = processEssay(f, raw);
  writeFileSync(f, updated);
  console.log(`  ✓ ${f}`);
}

for (const f of rfcFiles) {
  const raw = readFileSync(f, 'utf-8');
  const updated = processRfc(f, raw);
  writeFileSync(f, updated);
  console.log(`  ✓ ${f}`);
}

console.log('Done.');
