#!/usr/bin/env tsx
/**
 * generate-api-specs.ts
 *
 * Walks route.ts files across all 11 imajin services, detects HTTP method
 * exports, maps file paths to URL paths, and emits one openapi.yaml per
 * service under apps/<service>/api-spec/openapi.yaml.
 *
 * Usage:
 *   pnpm generate:api-specs
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { existsSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Service configuration
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceConfig {
  name: string;
  title: string;
  description: string;
  prodUrl: string;
  devUrl: string;
  port: number;
  /** Directories (relative to apps/<service>) that contain route.ts files */
  routeRoots: string[];
}

const SERVICES: ServiceConfig[] = [
  {
    name: 'auth',
    title: 'imajin auth',
    description: 'Identity registration, DID-based challenge-response authentication, session management, and magic-link flows.',
    prodUrl: 'https://auth.imajin.ai',
    devUrl: 'https://dev-auth.imajin.ai',
    port: 7001,
    routeRoots: ['app/api'],
  },
  {
    name: 'registry',
    title: 'imajin registry',
    description: 'Node registration, heartbeat, build attestation, and subdomain provisioning for the imajin.ai network.',
    prodUrl: 'https://registry.imajin.ai',
    devUrl: 'https://dev-registry.imajin.ai',
    port: 7002,
    routeRoots: ['app/api'],
  },
  {
    name: 'connections',
    title: 'imajin connections',
    description: 'Pod-based social graph — 2-person connection pods, invite codes, trust graph invites, pod management, and member/link operations.',
    prodUrl: 'https://connections.imajin.ai',
    devUrl: 'https://dev-connections.imajin.ai',
    port: 7003,
    routeRoots: ['app/api'],
  },
  {
    name: 'pay',
    title: 'imajin pay',
    description: 'Payments, balances, Stripe Connect onboarding, .fair multi-party settlement, escrow, and webhooks.',
    prodUrl: 'https://pay.imajin.ai',
    devUrl: 'https://dev-pay.imajin.ai',
    port: 7004,
    routeRoots: ['app/api'],
  },
  {
    name: 'profile',
    title: 'imajin profile',
    description: 'Profile management, follow graph, presence, guest identity, handle availability, and media serving.',
    prodUrl: 'https://profile.imajin.ai',
    devUrl: 'https://dev-profile.imajin.ai',
    port: 7005,
    routeRoots: ['app/api'],
  },
  {
    name: 'events',
    title: 'imajin events',
    description: 'Event creation, ticketing, ticket tiers, queue management, hold system, .fair manifests, checkout, and payment webhooks.',
    prodUrl: 'https://events.imajin.ai',
    devUrl: 'https://dev-events.imajin.ai',
    port: 7006,
    routeRoots: ['app/api'],
  },
  {
    name: 'chat',
    title: 'imajin chat',
    description: 'Conversations, messages, E2EE key bundles, event lobbies, reactions, invites, and media upload.',
    prodUrl: 'https://chat.imajin.ai',
    devUrl: 'https://dev-chat.imajin.ai',
    port: 7007,
    routeRoots: ['src/app/api'],
  },
  {
    name: 'media',
    title: 'imajin media',
    description: 'Asset upload and delivery with .fair access control, heuristic ML classification, virtual folder system, and thumbnail generation.',
    prodUrl: 'https://media.imajin.ai',
    devUrl: 'https://dev-media.imajin.ai',
    port: 7009,
    routeRoots: ['app/api'], // primary implementation
  },
  {
    name: 'coffee',
    title: 'imajin coffee',
    description: 'Tip pages and one-time or recurring support payments via Stripe Checkout and Solana.',
    prodUrl: 'https://coffee.imajin.ai',
    devUrl: 'https://dev-coffee.imajin.ai',
    port: 7100,
    routeRoots: ['app/api'],
  },
  {
    name: 'dykil',
    title: 'imajin dykil',
    description: 'Survey creation, publishing, and response collection. Supports SurveyJS schema and legacy field formats.',
    prodUrl: 'https://dykil.imajin.ai',
    devUrl: 'https://dev-dykil.imajin.ai',
    port: 7101,
    routeRoots: ['app/api'],
  },
  {
    name: 'links',
    title: 'imajin links',
    description: 'Link-in-bio pages with privacy-preserving click analytics, multiple links per page, and theme presets.',
    prodUrl: 'https://links.imajin.ai',
    devUrl: 'https://dev-links.imajin.ai',
    port: 7102,
    routeRoots: ['app/api'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HTTP methods exported from Next.js route handlers
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

const METHOD_EXPORT_RE = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

function detectMethods(source: string): HttpMethod[] {
  const methods: HttpMethod[] = [];
  let match: RegExpExecArray | null;
  METHOD_EXPORT_RE.lastIndex = 0;
  while ((match = METHOD_EXPORT_RE.exec(source)) !== null) {
    const m = match[1] as HttpMethod;
    if (!methods.includes(m)) methods.push(m);
  }
  return methods;
}

// ─────────────────────────────────────────────────────────────────────────────
// File system helpers
// ─────────────────────────────────────────────────────────────────────────────

async function findRoutesRecursive(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findRoutesRecursive(full)));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Convert a file path under `routeRoot` to an OpenAPI URL path.
 *
 * Examples:
 *   app/api/events/route.ts                    → /api/events
 *   app/api/events/[id]/route.ts               → /api/events/{id}
 *   app/api/events/[id]/tiers/route.ts         → /api/events/{id}/tiers
 *   app/api/media/[...path]/route.ts           → /api/media/{path}
 *   src/app/api/conversations/[id]/route.ts    → /api/conversations/{id}
 */
function filePathToUrlPath(absoluteFile: string, routeRootAbs: string): string {
  let rel = relative(routeRootAbs, absoluteFile); // e.g. "events/[id]/tiers/route.ts"
  rel = rel.replace(/\/route\.ts$/, '');          // remove /route.ts suffix
  // Convert [...param] → {param}, [param] → {param}
  rel = rel.replace(/\[\.\.\.([^\]]+)\]/g, '{$1}');
  rel = rel.replace(/\[([^\]]+)\]/g, '{$1}');
  return '/' + rel.replace(/\\/g, '/');           // prepend /api/ prefix included in routeRoot
}

// ─────────────────────────────────────────────────────────────────────────────
// Security scheme detection heuristics
// ─────────────────────────────────────────────────────────────────────────────

/** Simple heuristics — check source for auth patterns to determine security */
function detectSecurity(source: string, method: HttpMethod): string[] {
  const noAuth: HttpMethod[] = ['OPTIONS'];
  if (noAuth.includes(method)) return [];

  const schemes: string[] = [];

  if (/imajin_session|requireAuth|getSession|cookieAuth/.test(source)) {
    schemes.push('cookieAuth');
  }
  if (/stripe-signature|constructEvent|stripeWebhook/.test(source)) {
    schemes.push('stripeWebhook');
  }
  if (/PAY_SERVICE_API_KEY|apiKeyAuth/.test(source)) {
    schemes.push('apiKeyAuth');
  }
  if (/WEBHOOK_SECRET|Bearer.*webhook/i.test(source)) {
    schemes.push('webhookSecret');
  }
  if (/attestation|NodeAttestation|NodeHeartbeat/.test(source)) {
    schemes.push('attestation');
  }
  if (/bearerAuth|Bearer\s+token|Authorization.*Bearer/.test(source)) {
    if (!schemes.includes('apiKeyAuth') && !schemes.includes('webhookSecret')) {
      schemes.push('bearerAuth');
    }
  }

  return schemes;
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML emission helpers
// ─────────────────────────────────────────────────────────────────────────────

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
}

function buildSecuritySchemesYaml(service: ServiceConfig, allSchemes: Set<string>): string {
  const lines: string[] = ['  securitySchemes:'];

  if (allSchemes.has('cookieAuth')) {
    lines.push(
      '    cookieAuth:',
      '      type: apiKey',
      '      in: cookie',
      '      name: imajin_session',
    );
  }
  if (allSchemes.has('bearerAuth')) {
    lines.push(
      '    bearerAuth:',
      '      type: http',
      '      scheme: bearer',
    );
  }
  if (allSchemes.has('apiKeyAuth')) {
    lines.push(
      '    apiKeyAuth:',
      '      type: http',
      '      scheme: bearer',
      '      description: "PAY_SERVICE_API_KEY — internal service-to-service only"',
    );
  }
  if (allSchemes.has('stripeWebhook')) {
    lines.push(
      '    stripeWebhook:',
      '      type: apiKey',
      '      in: header',
      '      name: stripe-signature',
    );
  }
  if (allSchemes.has('webhookSecret')) {
    lines.push(
      '    webhookSecret:',
      '      type: http',
      '      scheme: bearer',
      '      description: "Bearer WEBHOOK_SECRET — internal payment callback"',
    );
  }
  if (allSchemes.has('attestation')) {
    lines.push(
      '    attestation:',
      '      type: http',
      '      scheme: bearer',
      '      description: "Ed25519-signed payload — signature embedded in request body, verified against registered public key"',
    );
  }

  return lines.join('\n');
}

function methodToOperationId(method: HttpMethod, urlPath: string): string {
  const verb: Record<HttpMethod, string> = {
    GET: 'get', POST: 'create', PUT: 'update', PATCH: 'patch',
    DELETE: 'delete', HEAD: 'head', OPTIONS: 'options',
  };
  // Turn /api/events/{id}/tiers → EventIdTiers
  const resource = urlPath
    .replace(/^\/api\//, '')
    .split('/')
    .map(seg => seg.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]/g, '_'))
    .filter(Boolean)
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
  return `${verb[method]}${resource}`;
}

function buildPathsYaml(routes: Array<{ urlPath: string; methods: HttpMethod[]; source: string }>): string {
  const lines: string[] = ['paths:'];

  // Group by URL path
  const byPath = new Map<string, Array<{ method: HttpMethod; source: string }>>();
  for (const route of routes) {
    if (!byPath.has(route.urlPath)) byPath.set(route.urlPath, []);
    for (const m of route.methods) {
      byPath.get(route.urlPath)!.push({ method: m, source: route.source });
    }
  }

  for (const [urlPath, ops] of byPath) {
    lines.push(`  ${urlPath}:`);
    for (const { method, source } of ops) {
      if (method === 'OPTIONS') continue; // skip — standard CORS preflight
      const m = method.toLowerCase();
      const operationId = methodToOperationId(method, urlPath);
      const security = detectSecurity(source, method);

      lines.push(`    ${m}:`);
      lines.push(`      operationId: ${operationId}`);
      lines.push(`      summary: "${method} ${urlPath}"`);

      if (security.length > 0) {
        lines.push('      security:');
        for (const s of security) {
          lines.push(`        - ${s}: []`);
        }
      }

      // Generic request body for mutation methods
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        lines.push(
          '      requestBody:',
          '        required: false',
          '        content:',
          '          application/json:',
          '            schema:',
          '              type: object',
        );
      }

      lines.push(
        '      responses:',
        '        "200":',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema:',
        '                type: object',
      );

      if (method === 'POST') {
        lines.push(
          '        "201":',
          '          description: Created',
        );
      }
      lines.push(
        '        "400":',
        '          description: Bad request',
        '        "401":',
        '          description: Unauthorized',
        '        "500":',
        '          description: Internal server error',
      );
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateSpec(service: ServiceConfig, repoRoot: string): Promise<void> {
  const serviceDir = join(repoRoot, 'apps', service.name);

  // Collect route files from all configured route roots
  const routes: Array<{ urlPath: string; methods: HttpMethod[]; source: string }> = [];
  const allSchemes = new Set<string>();

  for (const routeRoot of service.routeRoots) {
    const routeRootAbs = join(serviceDir, routeRoot);
    const files = await findRoutesRecursive(routeRootAbs);

    for (const file of files) {
      const source = await readFile(file, 'utf-8');
      const methods = detectMethods(source);
      if (methods.length === 0) continue;

      const urlPath = filePathToUrlPath(file, routeRootAbs);

      // Collect security schemes used
      for (const method of methods) {
        for (const s of detectSecurity(source, method)) {
          allSchemes.add(s);
        }
      }

      routes.push({ urlPath, methods, source });
    }
  }

  // Sort paths for deterministic output
  routes.sort((a, b) => a.urlPath.localeCompare(b.urlPath));

  const securitySchemesYaml = buildSecuritySchemesYaml(service, allSchemes);
  const pathsYaml = buildPathsYaml(routes);

  const yaml = [
    'openapi: "3.1.0"',
    'info:',
    `  title: ${service.title}`,
    '  version: "1.0.0"',
    `  description: ${service.description}`,
    'servers:',
    `  - url: ${service.prodUrl}`,
    '    description: production',
    `  - url: ${service.devUrl}`,
    '    description: dev',
    `  - url: http://localhost:${service.port}`,
    '    description: local',
    'components:',
    securitySchemesYaml,
    pathsYaml,
    '',
  ].join('\n');

  const outDir = join(serviceDir, 'api-spec');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'openapi.yaml');
  await writeFile(outFile, yaml, 'utf-8');
  console.log(`✓ ${service.name}: ${routes.length} paths → ${relative(repoRoot, outFile)}`);
}

async function main() {
  const repoRoot = join(import.meta.dirname ?? __dirname, '..');
  console.log(`Generating OpenAPI 3.1 specs from ${repoRoot}\n`);

  await Promise.all(SERVICES.map(s => generateSpec(s, repoRoot)));

  console.log('\nDone. Run `pnpm generate:api-specs` to regenerate.');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
