import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { listApiSpecs, readApiSpec } from '../api-specs';
import { KERNEL_CRON_MANIFEST } from '@/src/cron/schedule';

const kernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
afterEach(() => { vi.restoreAllMocks(); });
describe('discoverable registry expiry contract', () => {
  it('exposes the root cron route through the shipped /spec discovery and scheduler', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
    const path = '/api/cron/registry-app-expiry';
    expect(listApiSpecs().find(spec => spec.service === 'jin')?.paths).toContain(path);
    const route = parse(readApiSpec('jin')!.content).paths[path].get;
    expect(route.servers[0].url).toBe('https://{node}.imajin.ai');
    expect(route.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(route.responses)).toEqual(['200', '401', '500', '503']);
    expect(route.responses['200'].content['application/json'].schema.properties.checked.maximum).toBe(100);
    for (const policy of ['app.authorized', 'first_party', 'provision', 'claim', 'seven', 'registry.app.expired', 'Nothing is deleted']) {
      expect(route.description).toContain(policy);
    }
    expect(KERNEL_CRON_MANIFEST.jobs.find(job => job.path === path))
      .toEqual({ path, schedule: '*/10 * * * *', noOverlap: true });
    const types = parse(readApiSpec('auth')!.content).paths['/api/attestations/types'].get.description;
    for (const field of ['registry.app.expired', 'dcr-unconsented-ttl', 'appId', 'ttlDays: 7', 'createdAt', 'node-signed']) {
      expect(types).toContain(field);
    }
  });
});
