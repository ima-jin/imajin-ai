import { existsSync } from "node:fs";
import { join } from "node:path";
import { lore } from "@lore-vcs/sdk";
import { LoreEventTag, LoreLogLevel } from "@lore-vcs/sdk/types/enums";
import type { LoreRevisionCommitRevisionEvent } from "@lore-vcs/sdk/types/events";
import PQueue from "p-queue";
import { createLogger } from "@imajin/logger";
import type { BlobRef, BlobStore } from "./blob-store";

const log = createLogger("kernel");

const MEDIA_ROOT = process.env.MEDIA_ROOT ?? "/mnt/media";

/** Mirror of route.ts:didToPath — keep in sync or extract to a shared helper. */
function didToPath(did: string): string {
  return did.replaceAll(":", "_").replaceAll(/[^a-zA-Z0-9._@-]/g, "_");
}

/**
 * Register a single process-lifetime shutdown handler for the Lore FFI library.
 * Guards against double-registration during Next.js HMR restarts in dev mode.
 */
let shutdownRegistered = false;
function ensureLoreShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  lore.logConfigure({ level: LoreLogLevel.WARN });
  const shutdown = () => {
    try { lore.shutdown(); } catch { /* ignore errors on exit */ }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
}

export class LoreBlobStore implements BlobStore {
  /**
   * Per-DID write queues with concurrency=1.
   * Lore repos use file-based write locks — concurrent commits to the same repo
   * fail. Different DIDs have independent repos so their queues don't interact.
   */
  private readonly queues = new Map<string, PQueue>();

  /**
   * Cache of repo paths whose Lore repo is known to exist this process lifetime.
   * Avoids redundant filesystem checks on subsequent uploads from the same DID.
   */
  private readonly initializedRepos = new Set<string>();

  constructor() {
    ensureLoreShutdown();
  }

  private getQueue(ownerDid: string): PQueue {
    let queue = this.queues.get(ownerDid);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.queues.set(ownerDid, queue);
    }
    return queue;
  }

  /** Absolute path to the Lore repo root for a given DID. */
  private repoPath(ownerDid: string): string {
    return join(MEDIA_ROOT, didToPath(ownerDid));
  }

  /**
   * Idempotent repo initialization.
   * Checks for the `.lore` sentinel directory to skip `repositoryCreate` when
   * the repo already exists, then caches the result in-process.
   */
  private async ensureRepo(repoPath: string): Promise<void> {
    if (this.initializedRepos.has(repoPath)) return;
    if (!existsSync(join(repoPath, ".lore"))) {
      await lore
        .repositoryCreate(
          { repositoryPath: repoPath, offline: true },
          { repositoryUrl: `imajin-media:${repoPath}` },
        )
        .waitAsync();
    }
    this.initializedRepos.add(repoPath);
  }

  /**
   * Stage and commit the file at `filePath` into the owner's Lore repo.
   * The file must already exist on disk (call after writeFile).
   *
   * Serialized per-DID via the write queue — safe against concurrent uploads
   * from the same user, no-contention between different users.
   */
  async put(
    ownerDid: string,
    filePath: string,
    hint: { assetId: string; sizeBytes: number },
  ): Promise<BlobRef> {
    const repoPath = this.repoPath(ownerDid);

    return this.getQueue(ownerDid).add(async () => {
      await this.ensureRepo(repoPath);

      const globals = { repositoryPath: repoPath, offline: true };

      await lore.fileStage(globals, { paths: [filePath] }).waitAsync();

      const events = (await lore
        .revisionCommit(globals, { message: `upload: ${hint.assetId}` })
        .filterByType(LoreEventTag.REVISION_COMMIT_REVISION)
        .collectAsync()) as LoreRevisionCommitRevisionEvent[];

      const loreRef = events[0]?.data?.revision;
      if (!loreRef || loreRef.length !== 64) {
        throw new Error(
          `Lore revisionCommit did not return a valid revision hash (got: ${String(loreRef)})`,
        );
      }

      log.info({ ownerDid, assetId: hint.assetId, loreRef: loreRef.slice(0, 16) + "…" }, "Lore blob stored");
      return { loreRef, sizeBytes: hint.sizeBytes };
    }) as Promise<BlobRef>;
  }

  /**
   * No-op in Phase B.
   * #1122 will implement soft-supersede: mark the revision as HEAD-minus-N,
   * enabling rollback, and allowing Lore's GC to eventually reclaim the chunks.
   */
  async gc(ownerDid: string, loreRef: string): Promise<void> {
    log.info(
      { ownerDid, loreRef },
      "LoreBlobStore.gc: no-op in Phase B — soft-supersede deferred to #1122",
    );
  }
}

/**
 * Process-lifetime singleton. Import this throughout the kernel rather than
 * constructing new instances, so the per-DID queues and repo cache are shared.
 */
export const blobStore: BlobStore = new LoreBlobStore();
