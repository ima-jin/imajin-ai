import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('shared slotted connector removal contract', () => {
  it.each(['github', 'google', 'quickbooks'])('documents and enables removal on the existing %s disconnect endpoint', provider => {
    const spec = parse(readFileSync(`apps/kernel/api-spec/${provider}.yaml`, 'utf8'));
    const removal = spec.paths['/api/disconnect'].post;
    expect(removal.parameters).toContainEqual({
      name: 'remove', in: 'query', schema: { type: 'string', enum: ['true'] },
    });
    for (const status of ['200', '401', '404', '409', '503']) expect(removal.responses[status]).toBeDefined();
    expect(removal.description).toMatch(/signed connector\.disconnected/);
    expect(removal.description).toMatch(/Primary removal is blocked/);
    const route = readFileSync(`apps/kernel/app/${provider}/api/disconnect/route.ts`, 'utf8');
    expect(route).toContain('allowSlotRemoval: true');
    expect(route).toContain(`connectorName: '${provider}'`);
  });
});
