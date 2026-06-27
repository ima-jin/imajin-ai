import { lore } from "@lore-vcs/sdk";
import { LoreEventTag } from "@lore-vcs/sdk/types/enums";
import type { LoreRevisionHistoryEntryEvent } from "@lore-vcs/sdk/types/events";
import { join } from "node:path";
import { createLogger } from "@imajin/logger";
import { db, workspaceHistoryGrants } from "@/src/db";
import { and, eq } from "drizzle-orm";

const log = createLogger("kernel");
const MEDIA_ROOT = process.env.MEDIA_ROOT ?? "/mnt/media";

/** Mirror of route.ts:didToPath — extract to shared helper in a later pass. */
function didToPath(did: string): string {
  return did.replaceAll(":", "_").replaceAll(/[^a-zA-Z0-9._@-]/g, "_");
}

export interface RevisionEntry {
  /** 1-based revision index within the asset's own version chain (v1, v2, …). */
  versionNumber: number;
  /** 64-char SHA-256 hex — Lore's internal revision identifier. */
  loreRef: string;
  /** Direct parent's loreRef. Empty string for the genesis revision. */
  parentRef: string;
}

/**
 * History access policy — most-specific-wins, default HEAD-only.
 *
 * Current scope (#1123 Layer 2):
 *   owner → full history
 *   workspace grant (broad) → full history for any asset in the owner's workspace
 *   everyone else → HEAD-only (false)
 *
 * Designed to extend without redesign:
 *   asset override → [folder →] [project →] [group →] workspace default → HEAD-only
 */
export async function hasHistoryAccess(
  callerDid: string,
  ownerDid: string,
): Promise<boolean> {
  // Owner always has full access
  if (callerDid === ownerDid) return true;

  // Workspace-wide history grant (--broad DFOS tier, #1123)
  try {
    const [grant] = await db
      .select({ id: workspaceHistoryGrants.id })
      .from(workspaceHistoryGrants)
      .where(and(
        eq(workspaceHistoryGrants.ownerDid, ownerDid),
        eq(workspaceHistoryGrants.granteeDid, callerDid),
      ))
      .limit(1);
    if (grant) return true;
  } catch {
    // DB error — fail closed (no access)
  }

  // Default: HEAD-only
  return false;
}

/**
 * Fetch all Lore revisions for a DID's repo and walk the parent chain
 * starting from `currentLoreRef` to reconstruct the version history for
 * a single asset.
 *
 * Returns entries HEAD-first (most recent = index 0, versionNumber = N).
 * Returns `[]` if Lore repo doesn't exist or the asset has no loreRef
 * (pre-Lore upload or Lore put failed).
 */
export async function getAssetRevisionHistory(
  ownerDid: string,
  currentLoreRef: string | null | undefined,
): Promise<RevisionEntry[]> {
  if (!currentLoreRef) return [];

  const repoPath = join(MEDIA_ROOT, didToPath(ownerDid));
  const globals = { repositoryPath: repoPath, offline: true };

  let allEvents: LoreRevisionHistoryEntryEvent[];
  try {
    allEvents = (await lore
      .revisionHistory(globals, {})
      .filterByType(LoreEventTag.REVISION_HISTORY_ENTRY)
      .collectAsync()) as LoreRevisionHistoryEntryEvent[];
  } catch (err) {
    log.warn({ err: String(err), ownerDid }, "Lore revisionHistory failed — repo may not exist");
    return [];
  }

  // Build a lookup map: loreRef → raw event data
  const byRef = new Map<string, { loreRef: string; parentRef: string }>();
  for (const event of allEvents) {
    const loreRef = String(event.data.revision);
    const parentRef = String((event.data.parent as unknown as string[])[0] ?? "");
    byRef.set(loreRef, { loreRef, parentRef });
  }

  // Walk the parent chain from HEAD to genesis, collecting this asset's revisions.
  // Stops when the parent hash is absent from the map (genesis) or all-zero (sentinel).
  const ZERO_REF = "0".repeat(64);
  const chain: Array<{ loreRef: string; parentRef: string }> = [];
  let cur = byRef.get(currentLoreRef);
  while (cur) {
    chain.push(cur);
    const next = cur.parentRef && cur.parentRef !== ZERO_REF ? byRef.get(cur.parentRef) : undefined;
    cur = next;
  }

  // chain is HEAD-first; assign versionNumber descending so v1 = genesis
  const total = chain.length;
  return chain.map((entry, i) => ({
    versionNumber: total - i,
    loreRef: entry.loreRef,
    parentRef: entry.parentRef,
  }));
}
