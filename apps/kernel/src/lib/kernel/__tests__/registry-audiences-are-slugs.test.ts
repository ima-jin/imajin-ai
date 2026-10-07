/**
 * #2706 hard rule: no registry row lists a shared host (or any host) as a token
 * audience. The audiences the kernel writes by itself — the first-party seed
 * migration and `apps.provision` — must be slugs, so a Bearer token minted for
 * the app's registry audience is the only thing its verifier ever accepts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAppAudienceSlug } from '@imajin/auth';

const MIGRATIONS_DIR = resolve(__dirname, '../../../../../../migrations');

/** Every quoted element of every `ARRAY['…', …]` literal in a SQL file. */
function arrayLiterals(sql: string): string[] {
  const values: string[] = [];
  for (const match of sql.matchAll(/ARRAY\[([^\]]*)\]/g)) {
    for (const item of match[1].matchAll(/'([^']*)'/g)) values.push(item[1]);
  }
  return values;
}

describe('registry audiences are slugs, never hosts (#2706)', () => {
  it('the 0139 first-party seed registers slug audiences only', () => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, '0139_registry_apps_seed_first_party.sql'), 'utf8');
    const audiences = arrayLiterals(sql);

    expect(audiences).toEqual(expect.arrayContaining(['coffee', 'dykil', 'links', 'jin']));
    expect(audiences.filter((aud) => !isAppAudienceSlug(aud))).toEqual([]);
  });

  it('no migration writes a host into token_audiences', () => {
    const offenders = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .flatMap((file) => {
        const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
        return [...sql.matchAll(/token_audiences[^;]*?=\s*(ARRAY\[[^\]]*\])/gi)]
          .flatMap((m) => arrayLiterals(m[1]))
          .filter((aud) => !isAppAudienceSlug(aud))
          .map((aud) => `${file}: ${aud}`);
      });

    expect(offenders).toEqual([]);
  });
});
