import { describe, it, expect, afterEach, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GET } from '../route';
import { renderSpecRoute } from '@/src/lib/kernel/__tests__/spec-route-test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /chat/api/spec', () => {
  it('serves the chat OpenAPI spec YAML', async () => {
    const { res, body } = await renderSpecRoute(GET, import.meta.url);

    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    expect(body).toContain('openapi:');
    expect(body).toContain('/api/d/{did}/context');
  });

  /**
   * #1997 — /api/d/{did}/context was called by apps (events) via a
   * hand-built URL but undocumented. This pins the documented shape so a
   * future edit to the route can't silently drift from the spec.
   */
  it('documents PATCH /api/d/{did}/context with both auth paths and the context body', async () => {
    const { body } = await renderSpecRoute(GET, import.meta.url);
    const doc = parseYaml(body) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    const contextPath = doc.paths?.['/api/d/{did}/context'];
    expect(contextPath).toBeDefined();

    const patchOp = contextPath?.patch as
      | {
          security?: Array<Record<string, unknown>>;
          requestBody?: {
            content?: {
              'application/json'?: {
                schema?: { required?: string[] };
              };
            };
          };
        }
      | undefined;
    expect(patchOp).toBeDefined();

    const securitySchemes = (patchOp?.security ?? []).flatMap((s) => Object.keys(s));
    expect(securitySchemes).toContain('cookieAuth');
    expect(securitySchemes).toContain('bearerAuth');

    const requiredBodyFields =
      patchOp?.requestBody?.content?.['application/json']?.schema?.required ?? [];
    expect(requiredBodyFields).toContain('context');
  });
});
