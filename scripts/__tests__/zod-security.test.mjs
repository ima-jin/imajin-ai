import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = new URL('../../', import.meta.url);
const advisory = 'GHSA-mrhx-c7xc-m3w5';
const lock = parse(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'));

describe('Zod security remediation (#3098)', () => {
  it('keeps every locked package and peer snapshot on a patched Zod release', () => {
    const resolutions = Object.keys(lock.packages).filter(key => key.startsWith('zod@'));
    expect(resolutions.length).toBeGreaterThan(0);
    for (const key of [...resolutions, ...Object.keys(lock.snapshots)]) {
      for (const [, major, minor, patch] of key.matchAll(/zod@(\d+)\.(\d+)\.(\d+)/g)) {
        expect(+major > 4 || (+major === 4 && (+minor > 6 || (+minor === 6 && +patch >= 6)))).toBe(true);
      }
    }
  });

  it.each(['apps/kernel', 'packages/llm'])('installs the locked version for %s', workspace => {
    const require = createRequire(new URL(`${workspace}/package.json`, root));
    const installed = require('zod/package.json').version;
    expect(lock.importers[workspace].dependencies.zod.version).toBe(installed);
    expect(lock.packages[`zod@${installed}`].resolution.integrity).toMatch(/^sha512-/);
  });

  it('still refuses this advisory if it reappears in the production audit', () => {
    const baseline = JSON.parse(readFileSync(new URL('.github/audit-baseline.json', root), 'utf8'));
    expect(baseline.advisories.map(entry => entry.id)).not.toContain(advisory);
    const report = join(mkdtempSync(join(tmpdir(), 'zod-audit-')), 'report.json');
    writeFileSync(report, JSON.stringify({
      advisories: {
        regression: {
          module_name: 'zod', severity: 'high', title: 'Zod regression',
          references: `https://github.com/advisories/${advisory}`, patched_versions: '>=4.6.6',
        },
      },
    }));
    const result = spawnSync(process.execPath, [new URL('scripts/audit-gate.mjs', root).pathname, report], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(advisory);
    expect(result.stdout).toContain('1 new');
  });
});
