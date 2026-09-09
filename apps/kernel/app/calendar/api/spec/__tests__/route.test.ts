import { describe, it, expect, afterEach, vi } from 'vitest';
import { GET } from '../route';
import { renderSpecRoute } from '@/src/lib/kernel/__tests__/spec-route-test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /calendar/api/spec', () => {
  it('serves the calendar OpenAPI spec YAML', async () => {
    const { res, body } = await renderSpecRoute(GET, import.meta.url);

    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    expect(body).toContain('openapi:');
    expect(body).toContain('/api/availability');
  });
});
