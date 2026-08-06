/**
 * In-process reader for the OpenAPI specs the kernel serves (#1636).
 *
 * The kernel already publishes one spec per service at `/{service}/api/spec`,
 * each read straight off `api-spec/{service}.yaml` — see
 * `app/auth/api/spec/route.ts` and its seven siblings, plus the JSON conversion
 * in `app/registry/api/specs/[service]/route.ts`. Those are HTTP routes, so the
 * only way to read them from inside the process was a self-call. This module is
 * the library form: the discovery MCP tools call it directly, exactly as the
 * media tools call the media query lib rather than fetching their own routes.
 *
 * Everything here is READ-ONLY and derived from files already on disk and
 * already publicly served. There is no write counterpart, by design.
 *
 * Path safety: `readApiSpec` resolves its argument against the enumerated
 * directory listing rather than interpolating it into a path, so a service name
 * containing `..` or `/` cannot escape `api-spec/` — it simply is not in the
 * allowlist and the read fails closed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SERVICES } from '@imajin/config';

/**
 * Cap on the spec text handed back, in characters.
 *
 * The specs are small today (tens of KB), but they end up inside a JSON-RPC
 * response body destined for a model context window, so the read is bounded with
 * a flag rather than left open-ended — the same contract as
 * `getAgentRunTranscript`.
 */
export const SPEC_MAX_CHARS = 400_000;

/** One spec, as summarised by {@link listApiSpecs}. */
export interface ApiSpecSummary {
  /** Service name, which is also the spec filename stem, e.g. `auth`. */
  service: string;
  /** Public route serving this spec verbatim, e.g. `/auth/api/spec`. */
  endpoint: string;
  /** Service label from `@imajin/config`, when the name is a known service. */
  label: string | null;
  /** `info.title` from the spec, or null when it has none. */
  title: string | null;
  /** `info.version` from the spec, or null when it has none. */
  version: string | null;
  /** Documented path templates, so a caller can see the shape before fetching. */
  paths: string[];
}

/** One spec's full text, as returned by {@link readApiSpec}. */
export interface ApiSpecDocument {
  service: string;
  endpoint: string;
  /** The spec source, truncated to the requested cap. */
  content: string;
  /** Media type of `content` — the files are YAML. */
  contentType: string;
  /** True when `content` was cut at the cap. */
  truncated: boolean;
}

/** Absolute path of the directory holding the spec files. */
export function specDirectory(): string {
  return join(process.cwd(), 'api-spec');
}

/** Public route that serves `service`'s spec. */
export function specEndpoint(service: string): string {
  return `/${service}/api/spec`;
}

const SERVICE_LABELS = new Map(SERVICES.map((s) => [s.name, s.label]));

/**
 * Spec filename stems present on disk, sorted for a stable listing.
 *
 * Returns `[]` rather than throwing when the directory is absent: a node built
 * without the spec files should report an empty catalogue, not fail every
 * discovery call.
 */
export function listApiSpecServices(): string[] {
  const dir = specDirectory();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();
}

function specPath(service: string): string {
  return join(specDirectory(), `${service}.yaml`);
}

/** Read one spec's raw text, or undefined when it is not in the catalogue. */
function readSpecText(service: string): string | undefined {
  if (!listApiSpecServices().includes(service)) return undefined;
  return readFileSync(specPath(service), 'utf-8');
}

interface ParsedSpec {
  info?: { title?: unknown; version?: unknown };
  paths?: Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Summarise one spec.
 *
 * A spec that fails to parse is summarised with nulls rather than dropped or
 * thrown: the caller should still learn the endpoint exists and can fetch the
 * raw text to see what is wrong with it.
 */
function summarise(service: string, text: string): ApiSpecSummary {
  let parsed: ParsedSpec = {};
  try {
    const value = parseYaml(text);
    if (typeof value === 'object' && value !== null) parsed = value as ParsedSpec;
  } catch {
    parsed = {};
  }

  const paths = parsed.paths;

  return {
    service,
    endpoint: specEndpoint(service),
    label: SERVICE_LABELS.get(service) ?? null,
    title: stringOrNull(parsed.info?.title),
    version: stringOrNull(parsed.info?.version),
    paths:
      typeof paths === 'object' && paths !== null && !Array.isArray(paths)
        ? Object.keys(paths).sort((a, b) => a.localeCompare(b))
        : [],
  };
}

/**
 * Every spec the node serves, in service-name order.
 *
 * This is the catalogue an agent reads first: it names the endpoints, so the
 * follow-up {@link readApiSpec} call is a lookup rather than a guess.
 */
export function listApiSpecs(): ApiSpecSummary[] {
  return listApiSpecServices().map((service) => summarise(service, readFileSync(specPath(service), 'utf-8')));
}

/**
 * Read one spec's source, capped at `maxChars` (default {@link SPEC_MAX_CHARS}).
 *
 * Returns `null` for a service with no spec on disk, so the caller can say
 * "unknown service" rather than surfacing a filesystem error. A non-positive or
 * non-finite `maxChars` falls back to the default instead of failing the read.
 */
export function readApiSpec(
  service: string,
  { maxChars }: { maxChars?: number } = {},
): ApiSpecDocument | null {
  const text = readSpecText(service);
  if (text === undefined) return null;

  const cap =
    maxChars !== undefined && Number.isFinite(maxChars) && maxChars > 0
      ? Math.trunc(maxChars)
      : SPEC_MAX_CHARS;

  const truncated = text.length > cap;

  return {
    service,
    endpoint: specEndpoint(service),
    content: truncated ? text.slice(0, cap) : text,
    contentType: 'text/yaml',
    truncated,
  };
}
