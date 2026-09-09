import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GET } from '../route';

/** `apps/kernel` — five levels up from app/calendar/api/spec/__tests__. */
const KERNEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /calendar/api/spec', () => {
  it('serves the calendar OpenAPI spec YAML', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(KERNEL_ROOT);

    const res = await GET();
    const body = await res.text();

    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    expect(body).toContain('openapi:');
    expect(body).toContain('/api/availability');
  });
});
