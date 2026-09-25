import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
  createPostgresMigrationsQuerier,
  getMigrationStatus,
  listMigrationFilenames,
  type MigrationStatusQuerier,
} from '../src/migration-status';

/**
 * postgres.js's `Sql` is a large callable-plus-methods interface; a real one
 * needs a live connection. Tests here only ever exercise the tagged-template
 * call `createPostgresMigrationsQuerier` actually makes, so a minimal fake
 * of just that call shape is cast through `unknown` (never `any`) into the
 * real type.
 */
type FakeSqlTag = (strings: TemplateStringsArray) => Promise<Array<Record<string, unknown>>>;

function asSql(tag: FakeSqlTag): postgres.Sql {
  return tag as unknown as postgres.Sql;
}

/** Creates a scratch directory with the given `.sql` filenames (empty content — only names matter here) and returns its path. */
function makeMigrationsDir(filenames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-status-test-'));
  for (const filename of filenames) {
    writeFileSync(join(dir, filename), '-- fixture\n');
  }
  return dir;
}

function querierReturning(filenames: string[]): MigrationStatusQuerier {
  return { getAppliedMigrationFilenames: () => Promise.resolve(filenames) };
}

function querierThrowing(message: string): MigrationStatusQuerier {
  return {
    getAppliedMigrationFilenames: () => Promise.reject(new Error(message)),
  };
}

describe('listMigrationFilenames', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lists only .sql files, sorted the same way scripts/migrate.mjs applies them', () => {
    dir = makeMigrationsDir(['0002_second.sql', '0001_first.sql', 'README.md', '0010_tenth.sql']);

    expect(listMigrationFilenames(dir)).toEqual(['0001_first.sql', '0002_second.sql', '0010_tenth.sql']);
  });
});

describe('getMigrationStatus', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reports a null head, zero applied, and every file pending on a fresh, never-migrated DB', async () => {
    dir = makeMigrationsDir(['0001_first.sql', '0002_second.sql']);

    const status = await getMigrationStatus(querierReturning([]), dir);

    expect(status).toEqual({ migrationHead: null, appliedCount: 0, pendingCount: 2 });
  });

  it('reports the highest applied filename as the head and counts remaining files as pending', async () => {
    dir = makeMigrationsDir(['0001_first.sql', '0002_second.sql', '0003_third.sql']);

    const status = await getMigrationStatus(querierReturning(['0001_first.sql', '0002_second.sql']), dir);

    expect(status).toEqual({ migrationHead: '0002_second.sql', appliedCount: 2, pendingCount: 1 });
  });

  it('reports zero pending once every known file has been applied', async () => {
    dir = makeMigrationsDir(['0001_first.sql', '0002_second.sql']);

    const status = await getMigrationStatus(querierReturning(['0001_first.sql', '0002_second.sql']), dir);

    expect(status).toEqual({ migrationHead: '0002_second.sql', appliedCount: 2, pendingCount: 0 });
  });

  it('sorts applied filenames to find the head even if the querier returns them out of order', async () => {
    dir = makeMigrationsDir(['0001_first.sql', '0002_second.sql', '0003_third.sql']);

    const status = await getMigrationStatus(querierReturning(['0003_third.sql', '0001_first.sql']), dir);

    expect(status.migrationHead).toBe('0003_third.sql');
    expect(status.appliedCount).toBe(2);
  });

  it('degrades to pendingCount: null (never throws) when the migrations directory is unreadable', async () => {
    const status = await getMigrationStatus(querierReturning(['0001_first.sql']), '/nonexistent/migrations/dir');

    expect(status).toEqual({ migrationHead: '0001_first.sql', appliedCount: 1, pendingCount: null });
  });

  it('degrades to an error shape (never throws) when the DB query itself fails', async () => {
    const status = await getMigrationStatus(querierThrowing('connection refused'), '/nonexistent/migrations/dir');

    expect(status).toEqual({
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: 'connection refused',
    });
  });
});

describe('createPostgresMigrationsQuerier', () => {
  it('returns an empty list without querying rows when public._migrations does not exist yet', async () => {
    const calls: string[] = [];
    const fakeSql: FakeSqlTag = (strings) => {
      calls.push(strings.join('?'));
      return Promise.resolve([{ reg: null }]);
    };

    const querier = createPostgresMigrationsQuerier(asSql(fakeSql));
    const filenames = await querier.getAppliedMigrationFilenames();

    expect(filenames).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('to_regclass');
  });

  it('reads filenames from public._migrations once the table exists', async () => {
    let callCount = 0;
    const fakeSql: FakeSqlTag = (strings) => {
      callCount += 1;
      if (strings.join('?').includes('to_regclass')) {
        return Promise.resolve([{ reg: '_migrations' }]);
      }
      return Promise.resolve([{ filename: '0001_first.sql' }, { filename: '0002_second.sql' }]);
    };

    const querier = createPostgresMigrationsQuerier(asSql(fakeSql));
    const filenames = await querier.getAppliedMigrationFilenames();

    expect(filenames).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(callCount).toBe(2);
  });
});
