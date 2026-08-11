import { describe, expect, it } from 'vitest';
import { APP_DISPLAY_NAME } from '@imajin/config';
import {
  themeInitScript,
  getActingAs,
  setActingAs,
  getActingAsHeaders,
  defaultViewport,
  buildServiceMetadata,
  getServiceRuntimeEnv,
  BRAND,
} from '../src/server';

describe('@imajin/ui/server entry', () => {
  it('exports themeInitScript as a script string', () => {
    expect(themeInitScript).toBeTypeOf('string');
  });

  it('exports the acting-as helpers as functions, safe to call outside a browser', () => {
    expect(getActingAs).toBeTypeOf('function');
    expect(setActingAs).toBeTypeOf('function');
    expect(getActingAsHeaders).toBeTypeOf('function');
    // globalThis.window is undefined in this (Node) test environment, so
    // these should no-op rather than throw — the same guard that makes them
    // safe to import into a Server Component.
    expect(getActingAs()).toBeNull();
    expect(getActingAsHeaders()).toStrictEqual({});
    expect(() => setActingAs('did:example:1')).not.toThrow();
  });

  it('exports the service-layout helpers', () => {
    expect(defaultViewport).toStrictEqual({ width: 'device-width', initialScale: 1 });
    const metadata = buildServiceMetadata('Test', 'A test service');
    expect(metadata.title).toBe(`Test | ${APP_DISPLAY_NAME}`);
    expect(getServiceRuntimeEnv()).toHaveProperty('domain');
  });

  it('exports the BRAND constant', () => {
    expect(BRAND.name).toBe(APP_DISPLAY_NAME);
  });
});
