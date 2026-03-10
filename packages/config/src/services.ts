/**
 * Canonical service manifest — single source of truth for all Imajin services.
 *
 * Consumers: registry specs, Caddy config, pm2 ecosystem, docs sync, shared nav.
 */

export type ServiceTier = "core" | "imajin";
export type ServiceVisibility = "public" | "authenticated" | "creator" | "internal";
export type ServiceCategory = "core" | "creator" | "developer" | "infrastructure";

export interface ServiceDefinition {
  /** Subdomain / app directory name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Description */
  description: string;
  /** Emoji icon */
  icon: string;
  /** Dev port (3xxx) */
  devPort: number;
  /** Prod port (7xxx) */
  prodPort: number;
  /** Postgres schema name (null if no DB) */
  schema: string | null;
  /** Deployment tier */
  tier: ServiceTier;
  /** Visibility in launcher / nav */
  visibility: ServiceVisibility;
  /** Grouping category */
  category: ServiceCategory;
}

export const SERVICES: readonly ServiceDefinition[] = [
  // Core platform
  { name: "www",         label: "Home",        icon: "🏠", description: "Home — the Imajin network",                       devPort: 3000, prodPort: 7000, schema: "public",      tier: "core",   visibility: "public",        category: "core" },
  { name: "auth",        label: "Auth",        icon: "🔐", description: "Authentication and identity",                     devPort: 3001, prodPort: 7001, schema: "auth",        tier: "core",   visibility: "internal",      category: "infrastructure" },
  { name: "registry",    label: "Registry",    icon: "📡", description: "Node registration, heartbeat, and subdomain provisioning", devPort: 3002, prodPort: 7002, schema: "registry", tier: "core", visibility: "authenticated", category: "developer" },
  { name: "connections", label: "Connections", icon: "🤝", description: "Social connections, pods, and trust invites",      devPort: 3003, prodPort: 7003, schema: "connections", tier: "core",   visibility: "authenticated", category: "core" },
  { name: "pay",         label: "Pay",         icon: "💳", description: "Payments, escrow, and balance management",         devPort: 3004, prodPort: 7004, schema: "pay",         tier: "core",   visibility: "authenticated", category: "core" },
  { name: "profile",     label: "Profile",     icon: "👤", description: "User profiles and social graph",                   devPort: 3005, prodPort: 7005, schema: "profile",     tier: "core",   visibility: "authenticated", category: "core" },
  { name: "events",      label: "Events",      icon: "🎫", description: "Event creation, ticketing, and management",        devPort: 3006, prodPort: 7006, schema: "events",      tier: "core",   visibility: "public",        category: "core" },
  { name: "chat",        label: "Messages",    icon: "💬", description: "Real-time messaging and conversations",            devPort: 3007, prodPort: 7007, schema: "chat",        tier: "core",   visibility: "authenticated", category: "core" },
  { name: "input",       label: "Input",       icon: "📥", description: "Media upload relay and Whisper transcription",      devPort: 3008, prodPort: 7008, schema: null,          tier: "core",   visibility: "internal",      category: "infrastructure" },
  { name: "media",       label: "Media",       icon: "🖼️", description: "Media asset management, upload, and classification", devPort: 3009, prodPort: 7009, schema: "media",     tier: "core",   visibility: "authenticated", category: "core" },

  // Imajin apps
  { name: "coffee",      label: "Coffee",      icon: "☕", description: "Tipping and creator support pages",                devPort: 3100, prodPort: 7100, schema: "coffee",      tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "dykil",       label: "Surveys",     icon: "📋", description: "Surveys and do-you-know-if-I-like polls",          devPort: 3101, prodPort: 7101, schema: "dykil",       tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "links",       label: "Links",       icon: "🔗", description: "Link-in-bio pages and click tracking",             devPort: 3102, prodPort: 7102, schema: "links",       tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "learn",       label: "Learn",       icon: "📚", description: "Courses, lessons, and learning progress",          devPort: 3103, prodPort: 7103, schema: "learn",       tier: "imajin", visibility: "public",        category: "core" },

  // Connected apps (separate repos) will use the plugin architecture (#249).
  // Not included here — they authenticate via delegated sessions, not the monorepo manifest.
] as const satisfies readonly ServiceDefinition[];

// ── Lookup helpers ──────────────────────────────────────────────────────────

/** Get a service definition by name */
export function getService(name: string): ServiceDefinition | undefined {
  return SERVICES.find((s) => s.name === name);
}

/** Get the port for a service in a given environment */
export function getPort(name: string, env: "dev" | "prod" = "dev"): number | undefined {
  const svc = getService(name);
  return svc ? (env === "prod" ? svc.prodPort : svc.devPort) : undefined;
}

/** Get internal URL for a service (server-side calls) */
export function getServiceUrl(name: string, env: "dev" | "prod" = "dev"): string | undefined {
  const port = getPort(name, env);
  return port ? `http://localhost:${port}` : undefined;
}

/** Get the public URL for a service */
export function getPublicUrl(
  name: string,
  options?: { prefix?: string; domain?: string }
): string {
  const domain = options?.domain || "imajin.ai";
  const prefix = options?.prefix;
  const subdomain = prefix ? `${prefix}-${name}` : name;
  return `https://${subdomain}.${domain}`;
}

/** All service names */
export const SERVICE_NAMES = SERVICES.map((s) => s.name);

/** Services filtered by tier */
export function servicesByTier(tier: ServiceTier): ServiceDefinition[] {
  return SERVICES.filter((s) => s.tier === tier);
}

/** Services filtered by visibility */
export function servicesByVisibility(visibility: ServiceVisibility): ServiceDefinition[] {
  return SERVICES.filter((s) => s.visibility === visibility);
}

/**
 * Build a map of service name → internal URL from env vars with fallback to port convention.
 * Env var pattern: `{NAME}_SERVICE_URL` (e.g. `AUTH_SERVICE_URL`)
 */
export function buildServiceUrlMap(env: Record<string, string | undefined>, mode: "dev" | "prod" = "dev"): Record<string, string> {
  const map: Record<string, string> = {};
  for (const svc of SERVICES) {
    const envKey = `${svc.name.toUpperCase()}_SERVICE_URL`;
    const port = mode === "prod" ? svc.prodPort : svc.devPort;
    map[svc.name] = env[envKey] || `http://localhost:${port}`;
  }
  return map;
}
