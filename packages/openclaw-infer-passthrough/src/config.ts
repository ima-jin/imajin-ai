/**
 * Config loading (imajin-ai#1926). Two sources, deliberately kept apart:
 *
 *   - Environment variables carry every secret (the app's Ed25519 private
 *     key, and each route's break-glass direct API key) and the small set of
 *     host-wiring knobs (bind host/port, kernel base URL, timeouts).
 *   - `INFER_PROXY_ROUTES_CONFIG` points at a JSON file holding the
 *     non-secret route table (`ProviderRouteConfig[]`) — provider ids,
 *     principal/attestation ids, model prefixes, and *names* of the env vars
 *     holding each route's direct API key (never the key itself). This file
 *     is safe to commit to the gateway host's own config repo/dotfiles;
 *     nothing in it can mint a token or call a provider on its own.
 *
 * See the README for the exact env var names and the JSON shape.
 */
import { readFileSync } from 'node:fs';
import type { ProviderRouteConfig, ProxyConfig } from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_KERNEL_TIMEOUT_MS = 20_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 20_000;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required (see packages/openclaw-infer-passthrough/README.md)`);
  }
  return value;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function isValidRoute(value: unknown): value is ProviderRouteConfig {
  if (!value || typeof value !== 'object') return false;
  const route = value as Record<string, unknown>;
  return (
    typeof route.id === 'string' &&
    route.id.length > 0 &&
    typeof route.principalDid === 'string' &&
    route.principalDid.length > 0 &&
    typeof route.attestationId === 'string' &&
    route.attestationId.length > 0
  );
}

export function loadRoutes(configPath: string): ProviderRouteConfig[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read routes config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Routes config at ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Routes config at ${configPath} must be a JSON array of route entries`);
  }

  const invalid = parsed.filter((entry) => !isValidRoute(entry));
  if (invalid.length > 0) {
    throw new Error(
      `Routes config at ${configPath} has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} missing a required field (id, principalDid, attestationId)`,
    );
  }

  const routes = parsed as ProviderRouteConfig[];
  const seenIds = new Set<string>();
  for (const route of routes) {
    if (seenIds.has(route.id)) {
      throw new Error(`Routes config at ${configPath} has a duplicate route id: ${route.id}`);
    }
    seenIds.add(route.id);
  }
  return routes;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const routesPath = requireEnv(env, 'INFER_PROXY_ROUTES_CONFIG');
  return {
    host: env.INFER_PROXY_HOST || DEFAULT_HOST,
    port: parsePositiveInt(env, 'INFER_PROXY_PORT', DEFAULT_PORT),
    kernelBaseUrl: requireEnv(env, 'KERNEL_BASE_URL'),
    kernelTimeoutMs: parsePositiveInt(env, 'KERNEL_TIMEOUT_MS', DEFAULT_KERNEL_TIMEOUT_MS),
    directTimeoutMs: parsePositiveInt(env, 'DIRECT_TIMEOUT_MS', DEFAULT_DIRECT_TIMEOUT_MS),
    appDid: requireEnv(env, 'OPENCLAW_APP_DID'),
    appPrivateKey: requireEnv(env, 'OPENCLAW_APP_PRIVATE_KEY'),
    routes: loadRoutes(routesPath),
  };
}

/** Resolve a route's break-glass direct API key from env, or undefined if unconfigured. */
export function resolveDirectApiKey(route: ProviderRouteConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!route.directApiKeyEnvVar) return undefined;
  return env[route.directApiKeyEnvVar] || undefined;
}
