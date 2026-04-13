/**
 * Canonical service manifest — single source of truth for all Imajin services.
 *
 * Consumers: registry specs, Caddy config, pm2 ecosystem, docs sync, shared nav.
 */

export type ServiceTier = "core" | "imajin";
export type ServiceVisibility = "public" | "authenticated" | "creator" | "internal";
export type ServiceCategory = "kernel" | "core" | "creator" | "developer" | "infrastructure" | "meta";

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
  /** External URL override (bypasses subdomain convention) */
  externalUrl?: string;
  /** Path on www service (env-aware — resolves against www's URL at runtime) */
  wwwPath?: string;
}

export const SERVICES: readonly ServiceDefinition[] = [
  // Kernel services — individually visible, all run on the kernel process (port 3000/7000)
  { name: "kernel",      label: "Home",        icon: "🏠", description: "Network home — launcher, articles, stats",           devPort: 3000, prodPort: 7000, schema: null,          tier: "core",   visibility: "public",        category: "kernel" },
  { name: "auth",        label: "Identity",    icon: "🔑", description: "Authentication, keys, and identity management",      devPort: 3000, prodPort: 7000, schema: "auth",        tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "profile",     label: "Profile",     icon: "👤", description: "Your profile, settings, and display preferences",    devPort: 3000, prodPort: 7000, schema: "profile",     tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "connections", label: "Connections", icon: "🤝", description: "Your network — people you know and trust",           devPort: 3000, prodPort: 7000, schema: "connections", tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "chat",        label: "Chat",        icon: "💬", description: "Conversations and group messaging",                  devPort: 3000, prodPort: 7000, schema: "chat",        tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "pay",         label: "Wallet",      icon: "💰", description: "Payments, settlements, and MJN balance",             devPort: 3000, prodPort: 7000, schema: "pay",         tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "media",       label: "Media",       icon: "📁", description: "Files, images, and .fair attribution",               devPort: 3000, prodPort: 7000, schema: "media",       tier: "core",   visibility: "authenticated", category: "kernel" },
  { name: "registry",    label: "Registry",    icon: "📡", description: "Service registry and DFOS relay",                    devPort: 3000, prodPort: 7000, schema: "registry",    tier: "core",   visibility: "public",        category: "kernel" },
  { name: "notify",      label: "Notify",      icon: "🔔", description: "Notifications and preferences",                     devPort: 3000, prodPort: 7000, schema: "notify",      tier: "core",   visibility: "internal",      category: "kernel" },

  // Core apps — separate processes
  { name: "events",      label: "Events",      icon: "🎫", description: "Event creation, ticketing, and management",         devPort: 3006, prodPort: 7006, schema: "events",      tier: "core",   visibility: "public",        category: "core" },

  // Imajin apps
  { name: "coffee",      label: "Coffee",      icon: "☕", description: "Tipping and creator support pages",                 devPort: 3100, prodPort: 7100, schema: "coffee",      tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "dykil",       label: "Surveys",     icon: "📋", description: "Surveys and do-you-know-if-I-like polls",           devPort: 3101, prodPort: 7101, schema: "dykil",       tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "links",       label: "Links",       icon: "🔗", description: "Link-in-bio pages and click tracking",              devPort: 3102, prodPort: 7102, schema: "links",       tier: "imajin", visibility: "creator",       category: "creator" },
  { name: "learn",       label: "Learn",       icon: "📚", description: "Courses, lessons, and learning progress",           devPort: 3103, prodPort: 7103, schema: "learn",       tier: "imajin", visibility: "public",        category: "core" },
  { name: "market",      label: "Market",      icon: "🏪", description: "Local commerce — buy and sell with trust",          devPort: 3104, prodPort: 7104, schema: "market",      tier: "imajin", visibility: "public",        category: "core" },

  // Meta — project info and external resources surfaced in the launcher
  { name: 'project',     label: 'Project',     icon: '📖', description: 'Thesis, whitepaper, essays, RFCs',                  devPort: 3000, prodPort: 7000, schema: "public",      tier: 'core',   visibility: 'public',        category: 'meta', wwwPath: '/project' },
  { name: 'github',      label: 'GitHub',      icon: '🐙', description: 'Source code',                                       devPort: 3000, prodPort: 7000, schema: "public",      tier: 'core',   visibility: 'public',        category: 'meta', externalUrl: 'https://github.com/ima-jin/imajin-ai' },
  { name: 'docs',        label: 'Docs',        icon: '📄', description: 'API documentation',                                 devPort: 3000, prodPort: 7000, schema: "public",      tier: 'core',   visibility: 'public',        category: 'meta', wwwPath: '/developer-guide' },

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

/** Get the public URL for a service.
 *  Localhost-aware: if domain contains "localhost" or prefix is "http://localhost:",
 *  returns http://localhost:{devPort} using the canonical port map.
 */
export function getPublicUrl(
  name: string,
  options?: { prefix?: string; domain?: string }
): string {
  const svc = SERVICES.find((s) => s.name === name);

  // External URL takes absolute priority (e.g. GitHub)
  if (svc?.externalUrl) return svc.externalUrl;

  const domain = options?.domain || "imajin.ai";
  const prefix = options?.prefix;

  // wwwPath: resolve against www's URL (env-aware)
  if (svc?.wwwPath) {
    const wwwUrl = getPublicUrl("www", options);
    return `${wwwUrl}${svc.wwwPath}`;
  }

  // Detect localhost dev environment
  if (domain.includes("localhost") || prefix?.includes("localhost")) {
    const port = getPort(name, "dev");
    return port ? `http://localhost:${port}` : `http://localhost:3000`;
  }

  // Single-domain mode: prefix contains dots (e.g. "dev-jin.imajin.ai/")
  // Build https://{prefix}{name} instead of https://{prefix}-{name}.{domain}
  if (prefix && prefix.includes(".")) {
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    // "www" or "kernel" = root of the node, no suffix
    if (name === "www" || name === "kernel") return `https://${base}`;
    return `https://${base}/${name}`;
  }

  const subdomain = prefix ? `${prefix}-${name}` : name;
  return `https://${subdomain}.${domain}`;
}

/**
 * Build the public URL for a service using raw env vars.
 * Convenience wrapper around getPublicUrl that handles NEXT_PUBLIC_SERVICE_PREFIX
 * and NEXT_PUBLIC_DOMAIN directly (no need to strip protocol).
 *
 * @example
 *   buildPublicUrl('www')           → uses env vars, localhost-aware
 *   buildPublicUrl('auth', prefix, domain) → explicit values
 */
export function buildPublicUrl(
  name: string,
  servicePrefix?: string,
  domain?: string
): string {
  // Check for explicit NEXT_PUBLIC_{NAME}_URL env var first (kernel single-domain mode)
  if (!servicePrefix && !domain && typeof process !== "undefined") {
    const envKey = `NEXT_PUBLIC_${name.toUpperCase()}_URL`;
    const explicit = process.env[envKey];
    if (explicit) return explicit;
  }

  const p = servicePrefix ?? (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SERVICE_PREFIX : undefined) ?? "https://";
  const d = domain ?? (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DOMAIN : undefined) ?? "imajin.ai";

  // Localhost detection
  if (p.includes("localhost") || d.includes("localhost")) {
    const port = getPort(name, "dev");
    return port ? `http://localhost:${port}` : `http://localhost:3000`;
  }

  // Kernel services live at /{name} on the same domain, not as subdomains.
  // Only fall through to subdomain construction for federated apps (events, coffee, etc.)
  // unless explicit prefix/domain args were passed (caller knows what they want).
  if (!servicePrefix && !domain) {
    const svc = SERVICES.find((s) => s.name === name);
    if (svc?.category === "kernel") {
      // "kernel" itself is the root, others are /{name}
      return name === "kernel" ? "" : `/${name}`;
    }
  }

  // Extract env prefix: "https://dev-" → "dev", "https://" → undefined
  const match = p.replace(/^https?:\/\//, "").replace(/-$/, "") || undefined;
  return getPublicUrl(name, { prefix: match, domain: d });
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
