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
    expect(auth?.paths).toEqual([...(auth?.paths ?? [])].sort());
  });

  it('gives every summary a non-empty service and endpoint', () => {
    pinCwdToKernel();
    for (const spec of listApiSpecs()) {
      expect(spec.service.length, spec.endpoint).toBeGreaterThan(0);
      expect(spec.endpoint).toBe(`/${spec.service}/api/spec`);
    }
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
