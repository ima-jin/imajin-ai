/**
 * Persists the trust-on-first-use (TOFU) pin of the kernel's Ed25519
 * signing public key (#2244, child of epic #2241).
 *
 * Unlike `engine/store.ts`'s `CorpusStore` — one SQLite file per owner
 * DID — this is node-level configuration: there is exactly one kernel this
 * corpus process talks to, so one singleton row in one small SQLite file
 * is enough. Reuses the same `better-sqlite3` + WAL pattern `CorpusStore`
 * already uses, under the same `data/corpus` root, rather than inventing a
 * different persistence mechanism for a single row.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface KernelTrustStoreOptions {
  /** Defaults to `<cwd>/data/corpus`, matching `CorpusStoreOptions.dataDir`. */
  dataDir?: string;
}

export interface PinnedKernelKey {
  publicKey: string;
  kid: string | null;
  pinnedAt: string;
}

interface KernelTrustRow {
  public_key: string;
  kid: string | null;
  pinned_at: string;
}

const SINGLETON_ID = 'singleton';

export class KernelTrustStore {
  private readonly db: Database.Database;

  constructor(options: KernelTrustStoreOptions = {}) {
    const dataDir = options.dataDir ?? join(process.cwd(), 'data', 'corpus');
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'kernel-trust.db'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kernel_trust (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        kid TEXT,
        pinned_at TEXT NOT NULL
      );
    `);
  }

  /** The currently pinned kernel key, or `null` before any pin has ever been recorded. */
  get(): PinnedKernelKey | null {
    const row = this.db
      .prepare('SELECT public_key, kid, pinned_at FROM kernel_trust WHERE id = ?')
      .get(SINGLETON_ID) as KernelTrustRow | undefined;

    if (!row) return null;
    return { publicKey: row.public_key, kid: row.kid, pinnedAt: row.pinned_at };
  }

  /**
   * Records `publicKey` as the trusted pin, overwriting any previous value.
   * Callers are responsible for only calling this on first boot (TOFU) or
   * an explicit operator-initiated re-pin — this method itself performs no
   * "already pinned" check, so it isn't the place that enforces "warn,
   * never silently re-pin" (see `kernel-trust.ts`).
   */
  pin(publicKey: string, kid: string | null, pinnedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO kernel_trust (id, public_key, kid, pinned_at)
         VALUES (@id, @publicKey, @kid, @pinnedAt)
         ON CONFLICT(id) DO UPDATE SET
           public_key = excluded.public_key,
           kid = excluded.kid,
           pinned_at = excluded.pinned_at`,
      )
      .run({ id: SINGLETON_ID, publicKey, kid, pinnedAt });
  }

  close(): void {
    this.db.close();
  }
}
