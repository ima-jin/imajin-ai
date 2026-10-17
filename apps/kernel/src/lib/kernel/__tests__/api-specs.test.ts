/**
 * Tests for the in-process OpenAPI spec reader (#1636).
 *
 * `specDirectory()` resolves against `process.cwd()`, which is the kernel app
 * root when Next serves it but the monorepo root under vitest. The cwd is
 * therefore pinned to `apps/kernel` so these run against the REAL spec files the
 * discovery tools will serve — a fixture directory would pass while the shipped
 * files were malformed or missing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  SPEC_MAX_CHARS,
  listApiSpecServices,
  listApiSpecs,
  readApiSpec,
  specDirectory,
  specEndpoint,
} from '../api-specs';

/** `apps/kernel` — four levels up from src/lib/kernel/__tests__. */
const KERNEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function pinCwdToKernel() {
  vi.spyOn(process, 'cwd').mockReturnValue(KERNEL_ROOT);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth connector specifications (#2365)', () => {
  it.each(['github', 'quickbooks'])('serves and labels the %s slot routes', async (provider) => {
    pinCwdToKernel();
    const route = provider === 'github'
      ? await import('../../../../app/github/api/spec/route')
      : await import('../../../../app/quickbooks/api/spec/route');
    const response = route.GET();
    expect(response.headers.get('Content-Type')).toBe('text/yaml');
    const spec = parse(await response.text());
    expect(spec.components.parameters.slot.schema.default).toBe('primary');
    expect(spec.paths['/api/connect'].parameters).toContainEqual({ $ref: '#/components/parameters/slot' });
    expect(listApiSpecs().find((item) => item.service === provider)?.label).toBeTruthy();
  });
});

describe('auth.yaml identity search contract (#2780)', () => {
  const auth = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/auth.yaml'), 'utf-8'));
  const search = auth.paths['/api/search']?.get;

  it('documents public GET with the real query threshold and clamped limit', () => {
    expect(search.security).toEqual([]);
    expect(search.parameters).toEqual([
      expect.objectContaining({
        name: 'q',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 2 },
      }),
      expect.objectContaining({
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 5, minimum: 1, maximum: 20 },
      }),
    ]);
    expect(search.description).toContain('soft-tier identities');
    expect(search.parameters[0].description).toContain('return 200 with `{ results: [] }`');
  });

  it('returns a results envelope referencing the exact search fields and nullability', () => {
    expect(search.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
      required: ['results'],
      additionalProperties: false,
      properties: {
        results: {
          type: 'array',
          maxItems: 20,
          items: { $ref: '#/components/schemas/IdentitySearchResult' },
        },
      },
    });
    const result = auth.components.schemas.IdentitySearchResult;
    const fields = ['did', 'handle', 'name', 'scope', 'subtype', 'avatarUrl', 'avatarAssetId'];
    expect(result.required).toEqual(fields);
    expect(Object.keys(result.properties)).toEqual(fields);
    expect(result.additionalProperties).toBe(false);
    for (const field of fields) {
      expect(result.properties[field].type, field).toEqual(
        ['did', 'scope'].includes(field) ? 'string' : ['string', 'null'],
      );
    }
  });

  it('documents only the emitted success and search failure responses', () => {
    expect(Object.keys(search.responses)).toEqual(['200', '500']);
    expect(search.responses['500'].content['application/json'].schema).toEqual({
      type: 'object',
      required: ['error'],
      additionalProperties: false,
      properties: {
        error: { type: 'string', const: 'Failed to search identities' },
      },
    });
  });
});

describe('jin.yaml loop spend contract (#2839)', () => {
  const jin = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/jin.yaml'), 'utf-8'));
  const spend = jin.paths['/api/loops/spend']?.get;
  const schemas = jin.components.schemas;

  it.each([
    ['/api/loops', 'app/api/loops/route.ts'],
    ['/api/loops/spend', 'app/api/loops/spend/route.ts'],
    ['/api/loops/{loopId}', 'app/api/loops/[loopId]/route.ts'],
  ])('%s has a live route and appears in discovery', (path, routeFile) => {
    pinCwdToKernel();
    expect(existsSync(join(KERNEL_ROOT, routeFile))).toBe(true);
    expect(listApiSpecs().find((s) => s.service === 'jin')?.paths).toContain(path);
  });

  it('serves the spend path through the real jin spec handler', async () => {
    pinCwdToKernel();
    const { GET } = await import('../../../../app/jin/api/spec/route');
    const res = GET();
    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    const served = parse(await res.text());
    expect(served.paths['/api/loops/spend'].get).toEqual(spend);
    expect(readApiSpec('jin')?.content).toContain('/api/loops/spend:');
  });

  it('documents root routing, cookie or Bearer auth, and only the parsed query parameters', () => {
    expect(spend.servers.map((server: { url: string }) => server.url)).toEqual([
      'https://{node}.imajin.ai', 'http://localhost:3000',
    ]);
    expect(spend.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
    expect(jin.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(spend.description).toContain('requireAuth');
    expect(spend.description).toContain('resolveActingDid');
    expect(spend.description).toContain('imajin_session_dev when IMAJIN_ENV=dev');
    expect(spend.parameters).toEqual([
      expect.objectContaining({ name: 'principal', in: 'query', required: false, schema: { type: 'string' } }),
      expect.objectContaining({
        name: 'window', in: 'query', required: false,
        schema: { type: 'string', pattern: expect.any(String), example: '2026-10' },
      }),
    ]);
    expect(spend.parameters[0].description).toContain('must equal it or returns 403');
    expect(spend.parameters[1].description).toContain('current UTC calendar month');
    expect(spend.parameters[1].description).toContain('inclusive end date');
    expect(spend.parameters[1].description).toContain('No maximum range length');
  });

  it.each([
    ['RegistrySpend', ['currency', 'windowFrom', 'windowTo', 'runs', 'issues', 'prs']],
    ['RegistryRunCost', ['runId', 'loopId', 'refs', 'summary', 'state', 'startedAt', 'lastSeenAt', 'metered']],
    ['RegistrySubjectCost', ['ref', 'runCount', 'meteredUsd']],
  ])('pins every returned field in %s', (name, fields) => {
    expect(schemas[name].required).toEqual(fields);
    expect(Object.keys(schemas[name].properties)).toEqual(fields);
    expect(schemas[name].additionalProperties).toBe(false);
  });

  it('preserves the run/subject structure and distinguishes absent metering, unknown USD and zero', () => {
    expect(spend.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/RegistrySpend',
    });
    expect(schemas.RegistrySpend.properties.currency).toEqual({ type: 'string', enum: ['USD'] });
    expect(schemas.RegistrySpend.properties.runs.items).toEqual({ $ref: '#/components/schemas/RegistryRunCost' });
    for (const field of ['issues', 'prs']) {
      expect(schemas.RegistrySpend.properties[field].items).toEqual({ $ref: '#/components/schemas/RegistrySubjectCost' });
    }
    expect(schemas.RegistryRunCost.properties.refs.additionalProperties).toBe(true);
    const metered = schemas.RegistryRunCost.properties.metered;
    expect(metered.type).toEqual(['object', 'null']);
    expect(metered.required).toEqual(['usd', 'turns']);
    expect(Object.keys(metered.properties)).toEqual(['usd', 'turns']);
    expect(metered.properties.usd.type).toEqual(['number', 'null']);
    expect(metered.properties.turns).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schemas.RegistrySubjectCost.properties.meteredUsd.type).toEqual(['number', 'null']);
    expect(metered.description).toContain('a known zero remains 0');
    for (const field of ['windowFrom', 'windowTo']) {
      expect(schemas.RegistrySpend.properties[field]).toMatchObject({ type: 'string', format: 'date-time' });
    }
    for (const field of ['startedAt', 'lastSeenAt']) {
      expect(schemas.RegistryRunCost.properties[field]).toMatchObject({ type: 'string', format: 'date-time' });
    }
  });

  it('documents all emitted errors, including auth failures, without inventing an error envelope', () => {
    expect(Object.keys(spend.responses)).toEqual(['200', '400', '401', '403', '500', '503']);
    for (const status of ['400', '401', '403', '500', '503']) {
      expect(spend.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Error',
      });
    }
    expect(spend.responses['400'].description).toContain('window must be YYYY-MM or YYYY-MM-DD..YYYY-MM-DD');
    expect(spend.responses['403'].description).toContain('principal must match the authenticated caller');
    expect(spend.responses['500'].description).toContain('Registry spend unavailable');
    expect(spend.responses['503'].description).toContain('Auth service unavailable');
    expect(spend.responses['200'].headers['Cache-Control'].schema.enum).toEqual(['no-store']);
  });
});

describe('specDirectory / specEndpoint', () => {
  it('resolves the api-spec directory under the working directory', () => {
    pinCwdToKernel();
    expect(specDirectory()).toBe(join(KERNEL_ROOT, 'api-spec'));
    expect(existsSync(specDirectory())).toBe(true);
  });

  it('names the public route that serves each spec', () => {
    // Pinned because these strings are what an agent will actually curl.
    expect(specEndpoint('auth')).toBe('/auth/api/spec');
    expect(specEndpoint('media')).toBe('/media/api/spec');
  });
});

describe('listApiSpecServices', () => {
  it('enumerates the shipped kernel specs, sorted', () => {
    pinCwdToKernel();
    const services = listApiSpecServices();

    expect(services).toEqual([...services].sort());
    // The two the issue named explicitly, plus the rest of the kernel surface.
    expect(services).toContain('auth');
    expect(services).toContain('media');
    expect(services).toContain('connections');
  });

  /**
   * A node built without the spec files should report an empty catalogue rather
   * than failing every discovery call — the surface degrades, it does not break.
   */
  it('returns an empty catalogue when the directory is absent', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(join(KERNEL_ROOT, 'does-not-exist'));
    expect(listApiSpecServices()).toEqual([]);
    expect(listApiSpecs()).toEqual([]);
  });
});

describe('listApiSpecs', () => {
  it('summarises every spec with its endpoint, title, version, and paths', () => {
    pinCwdToKernel();
    const auth = listApiSpecs().find((s) => s.service === 'auth');

    expect(auth).toBeDefined();
    expect(auth?.endpoint).toBe('/auth/api/spec');
    // Label comes from @imajin/config, so the agent sees the same name the UI does.
    expect(auth?.label).toBe('Identity');
    expect(auth?.title).toBeTruthy();
    expect(auth?.version).toBeTruthy();
    expect(auth?.paths.length).toBeGreaterThan(0);
    // Same comparator as `summarise`: locale collation orders the `{param}`
    // segments differently from default code-unit sort, so asserting against a
    // bare `.sort()` here would fail on paths like `/api/identity/{did}/sign`.
    expect(auth?.paths).toEqual([...(auth?.paths ?? [])].sort((a, b) => a.localeCompare(b)));
  });

  it('gives every summary a non-empty service and endpoint', () => {
    pinCwdToKernel();
    for (const spec of listApiSpecs()) {
      expect(spec.service.length, spec.endpoint).toBeGreaterThan(0);
      expect(spec.endpoint).toBe(`/${spec.service}/api/spec`);
    }
  });

  /**
   * Regression for #2124: `calendar.yaml` landed in #2111 but the service was
   * never added to `SERVICES`, so discovery silently reported `label: null`
   * for it. Every shipped spec should resolve to a real label.
   */
  it('resolves a non-null label for every shipped spec (#2124)', () => {
    pinCwdToKernel();
    for (const spec of listApiSpecs()) {
      expect(spec.label, spec.service).not.toBeNull();
    }
  });

  it('labels calendar (#2124)', () => {
    pinCwdToKernel();
    const calendar = listApiSpecs().find((s) => s.service === 'calendar');

    expect(calendar?.label).toBe('Calendar');
  });
});

describe('readApiSpec', () => {
  it('returns the spec source verbatim, uncapped by default', () => {
    pinCwdToKernel();
    const onDisk = readFileSync(join(specDirectory(), 'auth.yaml'), 'utf-8');
    const spec = readApiSpec('auth');

    expect(spec).not.toBeNull();
    expect(spec?.content).toBe(onDisk);
    expect(spec?.contentType).toBe('text/yaml');
    expect(spec?.truncated).toBe(false);
    expect(onDisk.length).toBeLessThanOrEqual(SPEC_MAX_CHARS);
  });

  it('truncates at max_chars and says so', () => {
    pinCwdToKernel();
    const spec = readApiSpec('auth', { maxChars: 40 });

    expect(spec?.content).toHaveLength(40);
    expect(spec?.truncated).toBe(true);
  });

  it('falls back to the default cap for a non-positive or non-finite max_chars', () => {
    pinCwdToKernel();
    for (const maxChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readApiSpec('auth', { maxChars })?.truncated).toBe(false);
    }
  });

  it('returns null for a service with no spec instead of throwing', () => {
    pinCwdToKernel();
    expect(readApiSpec('not-a-service')).toBeNull();
  });

  /**
   * The service name is resolved against the enumerated listing rather than
   * interpolated into a path, so traversal cannot reach outside `api-spec/`.
   */
  it('refuses a traversing service name', () => {
    pinCwdToKernel();
    for (const service of ['../package', '../../package', '/etc/passwd', 'auth/../../package']) {
      expect(readApiSpec(service), service).toBeNull();
    }
  });
});

/**
 * Route <-> spec parity for the previously-undocumented auth routes named in
 * #1983's Phase 0 audit: app-token mint/exchange (#1993), the internal
 * acting-for check (#1995), and onboarding poll/claim (#1996). Each entry
 * pins BOTH that the route file still exists on disk AND that `auth.yaml`
 * documents its path, so the two cannot silently drift apart again.
 */
describe('auth.yaml documents the kernel signing-key well-known route (#2244)', () => {
  it('/.well-known/kernel-signing-key has both a live route file and a documented spec path', () => {
    pinCwdToKernel();
    expect(existsSync(join(KERNEL_ROOT, 'app/auth/.well-known/kernel-signing-key/route.ts'))).toBe(true);

    const auth = listApiSpecs().find((s) => s.service === 'auth');
    expect(auth?.paths).toContain('/.well-known/kernel-signing-key');
  });
});

describe('auth.yaml documents live auth routes (#1993 #1995 #1996 #2780)', () => {
  const DOCUMENTED_ROUTES: ReadonlyArray<{ path: string; routeFile: string }> = [
    { path: '/api/apps/token', routeFile: 'app/auth/api/apps/token/route.ts' },
    { path: '/api/apps/token/service', routeFile: 'app/auth/api/apps/token/service/route.ts' },
    { path: '/api/apps/token/verify', routeFile: 'app/auth/api/apps/token/verify/route.ts' },
    { path: '/api/tokens/app', routeFile: 'app/auth/api/tokens/app/route.ts' },
    { path: '/api/tokens/app/verify', routeFile: 'app/auth/api/tokens/app/verify/route.ts' },
    { path: '/api/internal/verify-delegation', routeFile: 'app/auth/api/internal/verify-delegation/route.ts' },
    { path: '/api/onboard/poll', routeFile: 'app/auth/api/onboard/poll/route.ts' },
    { path: '/api/onboard/claim', routeFile: 'app/auth/api/onboard/claim/route.ts' },
    { path: '/api/search', routeFile: 'app/auth/api/search/route.ts' },
  ];

  it.each(DOCUMENTED_ROUTES)('$path has both a live route file and a documented spec path', ({ path, routeFile }) => {
    pinCwdToKernel();
    expect(existsSync(join(KERNEL_ROOT, routeFile)), routeFile).toBe(true);

    const auth = listApiSpecs().find((s) => s.service === 'auth');
    expect(auth?.paths, path).toContain(path);
  });

  it('marks the internal verify-delegation route with the internalKeyAuth security scheme', () => {
    pinCwdToKernel();
    const spec = readApiSpec('auth');
    expect(spec?.content).toContain('/api/internal/verify-delegation:');

    const authYamlText = readFileSync(join(specDirectory(), 'auth.yaml'), 'utf-8');
    const section = authYamlText.slice(authYamlText.indexOf('/api/internal/verify-delegation:'));
    const nextPathIndex = section.indexOf('\n  /api/', 1);
    const delegationBlock = nextPathIndex === -1 ? section : section.slice(0, nextPathIndex);

    expect(delegationBlock).toContain('internalKeyAuth');
  });
});

/**
 * Route <-> spec parity for the /jin operator-approvals rail (#2152): both
 * the list route and the decision route must have both a live route file
 * on disk AND a documented path in jin.yaml, so the two never drift.
 */
describe('jin.yaml documents both operator-approvals routes (#2152)', () => {
  const DOCUMENTED_ROUTES: ReadonlyArray<{ path: string; routeFile: string }> = [
    { path: '/api/operator-approvals', routeFile: 'app/jin/api/operator-approvals/route.ts' },
    {
      path: '/api/operator-approvals/{proposalId}/decision',
      routeFile: 'app/jin/api/operator-approvals/[proposalId]/decision/route.ts',
    },
  ];

  it.each(DOCUMENTED_ROUTES)('$path has both a live route file and a documented spec path', ({ path, routeFile }) => {
    pinCwdToKernel();
    expect(existsSync(join(KERNEL_ROOT, routeFile)), routeFile).toBe(true);

    const jin = listApiSpecs().find((s) => s.service === 'jin');
    expect(jin?.paths, path).toContain(path);
  });

  it('resolves the jin label from the SERVICES manifest', () => {
    pinCwdToKernel();
    const jin = listApiSpecs().find((s) => s.service === 'jin');
    expect(jin?.label).toBe('Jin');
  });
});
