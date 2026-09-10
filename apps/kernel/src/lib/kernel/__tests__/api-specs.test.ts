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
describe('auth.yaml documents the app-token, verify-delegation, and onboard poll/claim routes (#1993 #1995 #1996)', () => {
  const DOCUMENTED_ROUTES: ReadonlyArray<{ path: string; routeFile: string }> = [
    { path: '/api/apps/token', routeFile: 'app/auth/api/apps/token/route.ts' },
    { path: '/api/apps/token/service', routeFile: 'app/auth/api/apps/token/service/route.ts' },
    { path: '/api/apps/token/verify', routeFile: 'app/auth/api/apps/token/verify/route.ts' },
    { path: '/api/tokens/app', routeFile: 'app/auth/api/tokens/app/route.ts' },
    { path: '/api/tokens/app/verify', routeFile: 'app/auth/api/tokens/app/verify/route.ts' },
    { path: '/api/internal/verify-delegation', routeFile: 'app/auth/api/internal/verify-delegation/route.ts' },
    { path: '/api/onboard/poll', routeFile: 'app/auth/api/onboard/poll/route.ts' },
    { path: '/api/onboard/claim', routeFile: 'app/auth/api/onboard/claim/route.ts' },
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
