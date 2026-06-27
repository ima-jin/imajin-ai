/**
 * BlobStore — content storage abstraction for media asset bytes.
 *
 * Phase B (#1154): backed by Lore (EpicGames/lore-js), an open-source
 * content-addressed VCS. The working copy stays on disk at storagePath;
 * Lore registers the chunks in its immutable store for dedup and future
 * versioning.
 *
 * Read path (GET /api/assets/[id]): unchanged — readFile(storagePath) works
 * because Lore leaves the working copy on disk after commit.
 *
 * Phase A reads / Phase B writes:
 *   put()  — register a newly written file in Lore, returns loreRef for the DB
 *   gc()   — no-op placeholder; soft-supersede implemented by #1122
 */

export interface BlobRef {
  /**
   * 64-character SHA-256 hex string from Lore's REVISION_COMMIT_REVISION event.
   * Stored as `lore_ref` on the asset row. This is the Lore-internal storage
   * pointer — NOT a DFOS CID (those are parallel identifiers on the same row).
   */
  loreRef: string;
  sizeBytes: number;
}

export interface BlobStore {
  /**
   * Register the file at `filePath` in Lore storage.
   *
   * The file MUST already exist on disk — call this after writeFile().
   * Returns the Lore revision hash to be persisted on the asset row.
   *
   * @param ownerDid  DID of the asset owner (determines which Lore repo to use)
   * @param filePath  Absolute path to the file that was written to disk
   * @param hint      assetId (for the commit message) + sizeBytes
   */
  put(
    ownerDid: string,
    filePath: string,
    hint: { assetId: string; sizeBytes: number },
  ): Promise<BlobRef>;

  /**
   * Soft-mark a Lore revision as superseded.
   * No-op in Phase B; implemented by #1122 via revisionHistory.
   */
  gc(ownerDid: string, loreRef: string): Promise<void>;
}
