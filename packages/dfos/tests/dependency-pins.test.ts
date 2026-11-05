import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('DFOS dependency contract', () => {
  it.each(['../../../package.json', '../../../apps/kernel/package.json', '../package.json'])(
    'pins every existing DFOS dependency exactly to 0.55.0 in %s', (path) => {
      const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      const dependencies = manifest.dependencies;
      expect(dependencies['@metalabel/dfos-protocol']).toBe('0.55.0');
      if (path.includes('kernel')) expect(dependencies['@metalabel/dfos-web-relay']).toBe('0.55.0');
      expect(dependencies).not.toHaveProperty('@metalabel/dfos-client');
    },
  );
});
