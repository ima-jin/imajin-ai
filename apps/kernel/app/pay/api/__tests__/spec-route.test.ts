/**
 * #2563 — `GET /pay/api/spec` is a synchronous handler (no Promise) that
 * serves the cached pay OpenAPI document as YAML.
 */
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ readFileSync: vi.fn(() => 'openapi: 3.0.0\n') }));

vi.mock('node:fs', () => ({ readFileSync: state.readFileSync, default: { readFileSync: state.readFileSync } }));

import { GET } from '../spec/route';

describe('GET /pay/api/spec', () => {
  it('synchronously returns the spec as YAML and reads the file once', async () => {
    const first = GET();
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('text/yaml');
    expect(await first.text()).toBe('openapi: 3.0.0\n');

    await GET().text();
    expect(state.readFileSync).toHaveBeenCalledTimes(1);
  });
});
