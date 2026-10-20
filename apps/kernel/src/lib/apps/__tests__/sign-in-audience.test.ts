import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { APP_SIGN_IN_AUDIENCES, isAppSignInAudience } from '../sign-in-audience';

describe('sign-in audience vocabulary and additive migration', () => {
  it.each(APP_SIGN_IN_AUDIENCES)('accepts exact vocabulary %s', audience => {
    expect(isAppSignInAudience(audience)).toBe(true);
  });
  it.each([undefined, null, '', 'Anyone', ' members', 'public', 0, true, {}, []])('rejects %j', value => {
    expect(isAppSignInAudience(value)).toBe(false);
  });
  it('backfills members safely, preserves anyone on rerun, and constrains invalid/null writes', async () => {
    const db = new PGlite();
    try {
      await db.exec("CREATE SCHEMA registry; CREATE TABLE registry.apps (id text PRIMARY KEY); INSERT INTO registry.apps VALUES ('existing');");
      const migration = readFileSync(resolve(process.cwd(), 'migrations/0215_registry_apps_sign_in_audience.sql'), 'utf8');
      await db.exec(migration);
      expect((await db.query('SELECT sign_in_audience FROM registry.apps')).rows).toEqual([{ sign_in_audience: 'members' }]);
      await db.exec("UPDATE registry.apps SET sign_in_audience='anyone';");
      await db.exec(migration);
      expect((await db.query('SELECT sign_in_audience FROM registry.apps')).rows).toEqual([{ sign_in_audience: 'anyone' }]);
      await db.exec("INSERT INTO registry.apps (id) VALUES ('new');");
      expect((await db.query("SELECT sign_in_audience FROM registry.apps WHERE id='new'")).rows).toEqual([{ sign_in_audience: 'members' }]);
      await expect(db.exec("UPDATE registry.apps SET sign_in_audience='public';")).rejects.toThrow(/registry_apps_sign_in_audience_check/);
      await expect(db.exec('UPDATE registry.apps SET sign_in_audience=NULL;')).rejects.toThrow(/not-null/);
    } finally {
      await db.close();
    }
  }, 30_000);
});
