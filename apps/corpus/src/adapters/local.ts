/**
 * Local filesystem corpus adapter (#1732).
 *
 * Reads markdown/text/code files from a directory tree and normalizes them
 * into `ThreadDocument`s. This is the second corpus adapter — its purpose is
 * to prove the adapter pattern from #1729/#1728 generalizes: it depends only
 * on `../engine/types`, never on the engine itself, and the engine indexes
 * its documents with zero changes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type {
  AdapterFetchOptions,
  AdapterSyncResult,
  CorpusAdapter,
  SourceType,
  ThreadDocument,
  ThreadType,
} from '../engine/types';

// ─── File type mapping ───────────────────────────────────────────────────────

const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst']);
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb']);

function threadTypeForExtension(ext: string): ThreadType | undefined {
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return undefined;
}

// ─── Source parsing ──────────────────────────────────────────────────────────

/** Parses `"local:/path/to/directory"` into the directory path. */
export function parseLocalSource(source: string): string {
  const match = /^local:(.+)$/.exec(source);
  if (!match) {
    throw new Error(`Invalid local source "${source}". Expected format "local:/path/to/directory".`);
  }
  return match[1];
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

interface Frontmatter {
  title?: string;
  labels?: string[];
  author?: string;
}

/**
 * Parses a minimal subset of YAML frontmatter (`---`-delimited, flat
 * `key: value` and `key: [a, b]` pairs) — enough for `title`/`labels`/`tags`/
 * `author`, without pulling in a YAML dependency.
 */
function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w+):(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (key === 'title') {
      frontmatter.title = stripQuotes(value);
    } else if (key === 'labels' || key === 'tags') {
      frontmatter.labels = parseInlineList(value);
    } else if (key === 'author') {
      frontmatter.author = stripQuotes(value);
    }
  }

  return { frontmatter, body: content.slice(match[0].length) };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (/^["'].*["']$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map(item => stripQuotes(item.trim()))
    .filter(Boolean);
}

// ─── Title extraction ────────────────────────────────────────────────────────

/** Extracts the first H1 heading (`# Title`) from a markdown body, if any. */
function extractH1Title(body: string): string | undefined {
  const match = /^#\s(.+)$/m.exec(body);
  return match?.[1].trim();
}

function titleFor(fileName: string, body: string, frontmatter: Frontmatter): string {
  if (frontmatter.title) return frontmatter.title;
  const h1 = extractH1Title(body);
  if (h1) return h1;
  return fileName;
}

// ─── Linked refs ─────────────────────────────────────────────────────────────

/** Extracts `#123`-style refs and bare URLs from a body of text. */
function extractLinkedRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/#(\d+)/g)) {
    refs.add(`#${match[1]}`);
  }
  for (const match of body.matchAll(/https?:\/\/[^\s)]+/g)) {
    refs.add(match[0]);
  }
  return [...refs];
}

// ─── Directory walking ───────────────────────────────────────────────────────

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  type: ThreadType;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('LocalAdapter: fetch aborted');
  }
}

/** Recursively walks `root`, yielding every file with a recognized extension. */
function* walkDirectory(root: string, dir: string = root, signal?: AbortSignal): Generator<WalkedFile> {
  checkAborted(signal);
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(root, absolutePath, signal);
      continue;
    }
    if (!entry.isFile()) continue;

    const type = threadTypeForExtension(extname(entry.name));
    if (!type) continue;

    yield { absolutePath, relativePath: relative(root, absolutePath).replaceAll('\\', '/'), type };
  }
}

// ─── ThreadDocument construction ─────────────────────────────────────────────

function buildDocument(source: string, root: string, file: WalkedFile): ThreadDocument {
  const rawContent = readFileSync(file.absolutePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const stats = statSync(file.absolutePath);
  const fileName = file.relativePath.split('/').pop() ?? file.relativePath;
  const mtime = stats.mtime.toISOString();

  return {
    source,
    sourceType: 'local',
    id: file.relativePath,
    type: file.type,
    title: titleFor(fileName, body, frontmatter),
    state: 'open',
    labels: frontmatter.labels ?? [],
    author: frontmatter.author ?? '',
    created: stats.birthtime.toISOString(),
    updated: mtime,
    linkedRefs: extractLinkedRefs(body),
    body,
    comments: [],
    url: `file://${file.absolutePath}`,
    meta: { mtime },
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class LocalAdapter implements CorpusAdapter {
  readonly sourceType: SourceType = 'local';

  async *fetch(source: string, options: AdapterFetchOptions = {}): AsyncIterable<ThreadDocument> {
    const root = parseLocalSource(source);
    const limit = options.limit;
    let emitted = 0;

    for (const file of walkDirectory(root, root, options.signal)) {
      checkAborted(options.signal);
      if (limit != null && emitted >= limit) return;
      yield buildDocument(source, root, file);
      emitted++;
    }
  }

  async sync(source: string, cursor: string | null, options: AdapterFetchOptions = {}): Promise<AdapterSyncResult> {
    const root = parseLocalSource(source);
    const limit = options.limit;
    const documents: ThreadDocument[] = [];
    let latestMtime = cursor;
    let hasMore = false;

    for (const file of walkDirectory(root, root, options.signal)) {
      checkAborted(options.signal);
      const stats = statSync(file.absolutePath);
      const mtime = stats.mtime.toISOString();
      if (cursor && mtime <= cursor) continue;

      if (limit != null && documents.length >= limit) {
        hasMore = true;
        break;
      }

      documents.push(buildDocument(source, root, file));
      if (!latestMtime || mtime > latestMtime) {
        latestMtime = mtime;
      }
    }

    return { documents, cursor: latestMtime, hasMore };
  }
}
