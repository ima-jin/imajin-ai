/**
 * Persists the trust-on-first-use (TOFU) pin of the kernel's Ed25519
 * signing public key set (#2244, child of epic #2241).
 *
 * Unlike `engine/store.ts`'s `CorpusStore` — one SQLite file per owner
 * DID — this is node-level configuration: there is exactly one kernel this
 * corpus process talks to, so one small SQLite file is enough. Reuses the
 * same `better-sqlite3` + WAL pattern `CorpusStore` already uses, under the
 * same `data/corpus` root, rather than inventing a different persistence
 * mechanism for a handful of rows.
 *
 * Pins a SET of keys, kid-addressed, rather than a single key: the kernel's
 * well-known endpoint can serve both a current and a just-rotated-out key
 * during a grace window (`kernel-signing-key.ts`), and corpus must accept
 * either while that window is open (`kernel-trust.ts`, `access-claim.ts`).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface KernelTrustStoreOptions {
  /** Defaults to `<cwd>/data/corpus`, matching `CorpusStoreOptions.dataDir`. */
  dataDir?: string;
}

export interface PinnedKernelKey {
  kid: string;
  publicKey: string;
  pinnedAt: string;
}

interface KernelTrustRow {
  kid: string;
  public_key: string;
  pinned_at: string;
}

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
      CREATE TABLE IF NOT EXISTS kernel_trust_keys (
        kid TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        pinned_at TEXT NOT NULL
      );
    `);
  }

  /** Every currently pinned key, in `kid` order. Empty before anything has ever been pinned. */
  getAll(): PinnedKernelKey[] {
    const rows = this.db
      .prepare('SELECT kid, public_key, pinned_at FROM kernel_trust_keys ORDER BY kid')
      .all() as KernelTrustRow[];

    return rows.map((row) => ({ kid: row.kid, publicKey: row.public_key, pinnedAt: row.pinned_at }));
  }

  /**
   * Replaces the ENTIRE pinned key set atomically with `keys`, all stamped
   * with the same `pinnedAt`. Callers are responsible for only calling this
   * on first boot (TOFU), an explicit operator-initiated re-pin, or to
   * extend the pin with a newly-announced key that shares a trusted anchor
   * with the existing pin (see `kernel-trust.ts`) — this method itself
   * performs no "already pinned" or "shares an anchor" check.
   */
  pinSet(keys: ReadonlyArray<{ kid: string; publicKey: string }>, pinnedAt: string): void {
    const replace = this.db.transaction((rows: ReadonlyArray<{ kid: string; publicKey: string }>) => {
      this.db.prepare('DELETE FROM kernel_trust_keys').run();
      const insert = this.db.prepare('INSERT INTO kernel_trust_keys (kid, public_key, pinned_at) VALUES (?, ?, ?)');
      for (const key of rows) insert.run(key.kid, key.publicKey, pinnedAt);
    });
    replace(keys);
  }

  close(): void {
    this.db.close();
  }
}
