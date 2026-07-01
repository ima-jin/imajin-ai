// Relative imports for the media siblings (not "@/") so they resolve under the
// test runner, which loads these modules for real rather than mocking them.
import { readFile } from "node:fs/promises";
import { createLogger } from "@imajin/logger";
import { publish } from "@imajin/bus";
import { db, assets, channelLinks } from "@/src/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { parseFrontmatter } from "./frontmatter";
import {
  registerProjectionSurface,
  type ProjectionContext,
  type ProjectionSurface,
} from "./projection-reactor";

/**
 * Connector scope-manifest → `auth.channel_links` projection surface (#1209,
 * EPIC #1204) — the first ACTIVE application of the whole control-plane pattern.
 *
 * ── The proof ────────────────────────────────────────────────────────────────
 * A connector's permission grants live in a userspace SCOPE MANIFEST document
 * (a `.fair`-signed media asset, Q4). Editing that manifest projects through the
 * release-gated reactor (#1207) into the LIVE permission DB (`auth.channel_links`):
 * granting a scope materializes an ACTIVE link row; gating/deleting a scope
 * (#1208) flips the row to `revoked` and fires `channel.link.revoked` to kill
 * the downstream auth/refresh chain. One consent grammar across all connectors,
 * operated purely by editing an owned, signed document.
 *
 * ── The manifest document schema (discovered by convention) ──────────────────
 * The manifest is a media asset with `metadata.kind === 'scope-manifest'` (the
 * discovery convention; NOT a dedicated asset class). Its `.fair`-signed
 * frontmatter declares:
 *
 *   ---
 *   kind: scope-manifest                # optional in-file marker (asset metadata is authoritative for the gate)
 *   connector: did:imajin:github-connector   # REQUIRED — the connector (app) DID grants pin to
 *   channel: github                     # REQUIRED — the connector channel label
 *   "github:read":                      # one entry per scope; key is the scope name
 *     verb: read
 *     surface: repos
 *     label: "Read your repos, issues and PRs"
 *   "github:write": { verb: write, surface: issues, label: "..." }
 *   release:                            # per-scope #1206 release policy (parsed by #1207)
 *     "github:read": { discloses_others: false, sensitive: false }               # → silent
 *     "github:write": { discloses_others: false, sensitive: false, release: on-consent, viewer: "did:imajin:github-connector" }
 *     "github:org": { discloses_others: true, sensitive: false, viewer: "did:imajin:github-connector" }  # → on-consent
 *     "github:actions": { discloses_others: true, sensitive: true }              # → never
 *   ---
 *
 * The reactor (#1207) parses `release:`, runs each scope through the broker
 * latch, and hands this surface ONLY the scopes that passed the gate (`released`)
 * plus the ones reconciled OUT this change (`removedFields`). The scope
 * descriptor `{verb, surface, label}` is the released VALUE; the scope name is
 * the key. The DB row carries only the scope name — the signed file remains the
 * full truth (label/surface/verb/who-declared-it).
 *
 * ── Consent semantics (#1196 quadrant → connector authorization) ─────────────
 * A connector scope grant is the OWNER authorizing a CONNECTOR: broker subject =
 * ownerDid, requester/grantedTo = the connector's app DID (declared as the
 * scope's `viewer` in the release policy). An `on-consent` / `owner-only` scope
 * therefore materializes an active link ONLY when there is a matching active
 * `kernel.consent_grants` row (subject=ownerDid, granted_to=connectorDid,
 * purpose=`document.projection`, allowed_fields ∋ scope). Fail-closed (rule 2):
 * no grant ⇒ no active row.
 *
 * ── Import direction ─────────────────────────────────────────────────────────
 * packages/bus MUST NOT import apps/kernel. This surface is KERNEL-side; it only
 * CONSUMES the bus (`publish`) and the kernel projection contract
 * (`registerProjectionSurface`). It is registered from the media write path
 * (update-asset.ts) so it is loaded before `document.changed` is published.
 */

const log = createLogger("kernel");

/** The `metadata.kind` marker that identifies a scope-manifest asset (Q4). */
const SCOPE_MANIFEST_KIND = "scope-manifest";

/** Scope service for the revoke event (mirrors channel-link/[id]/route.ts). */
const CHANNEL_LINK_SCOPE = "auth";

/** Separator embedding the scope in a channel_links `channelUid`. */
const SCOPE_UID_SEP = "#";

/** Resolved connector identity read from the signed manifest frontmatter. */
interface ManifestConnector {
  /** Connector (app) DID grants pin to — `auth.channel_links.appDid`. */
  appDid: string;
  /** Connector channel label — `auth.channel_links.channel`. */
  channel: string;
}

/**
 * Build the `channelUid` for one manifest scope. The `auth.channel_links`
 * uniqueness constraint is (channel, channelUid, appDid); channel and appDid are
 * constant across a manifest's scopes, so the scope is embedded in channelUid to
 * give each scope its own row (one row per scope) AND scope the row to this
 * manifest asset — the prefix `${assetId}#` is how apply()/remove() find "the
 * rows for this manifest".
 */
function scopeUid(assetId: string, scope: string): string {
  return `${assetId}${SCOPE_UID_SEP}${scope}`;
}

/** Recover the scope name from a manifest channelUid (inverse of {@link scopeUid}). */
function scopeFromUid(assetId: string, channelUid: string): string | null {
  const prefix = `${assetId}${SCOPE_UID_SEP}`;
  return channelUid.startsWith(prefix) ? channelUid.slice(prefix.length) : null;
}

/** Deterministic primary key for a manifest scope's link row (stable across edits). */
function scopeLinkId(assetId: string, scope: string): string {
  return `clink_${assetId}_${scope.replaceAll(":", "_")}`;
}

/**
 * The gate (task requirement): load the asset by `ctx.assetId` and no-op unless
 * it is a scope-manifest. Also resolves the connector DID + channel from the
 * SIGNED frontmatter (the file is the source of truth). Returns `null` (⇒ full
 * no-op) for any non-manifest asset or a manifest missing its connector
 * identity (fail-closed — we never create an unattributed link row).
 */
async function resolveManifestConnector(
  ctx: ProjectionContext,
): Promise<ManifestConnector | null> {
  const [row] = await db
    .select({ metadata: assets.metadata })
    .from(assets)
    .where(eq(assets.id, ctx.assetId))
    .limit(1);

  const metadata =
    row?.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};

  // Gate to manifests ONLY: leave article/other docs' channel_links untouched.
  if (metadata.kind !== SCOPE_MANIFEST_KIND) return null;

  let content: string;
  try {
    content = await readFile(ctx.path, "utf-8");
  } catch (err) {
    log.error(
      { err: String(err), assetId: ctx.assetId },
      "channel-links surface: could not read manifest document",
    );
    return null;
  }

  const { data } = parseFrontmatter(content);
  const appDid = typeof data.connector === "string" ? data.connector : null;
  const channel = typeof data.channel === "string" ? data.channel : null;
  if (!appDid || !channel) {
    log.warn(
      { assetId: ctx.assetId },
      "channel-links surface: manifest missing connector/channel; projecting nothing (fail-closed)",
    );
    return null;
  }

  return { appDid, channel };
}

/** Flip active link rows to revoked and fire `channel.link.revoked` per row. */
async function revokeLinkRows(
  ctx: ProjectionContext,
  rows: Array<{ id: string; channel: string; did: string; appDid: string }>,
): Promise<void> {
  for (const row of rows) {
    await db
      .update(channelLinks)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(channelLinks.id, row.id));

    // Kill the downstream auth/refresh chain — reuse the existing revoke seam
    // (#1195/#1182), mirroring auth/api/channel-link/[id]/route.ts. Non-fatal:
    // the signed file is authoritative, so a publish failure self-heals on the
    // next edit rather than corrupting the projection.
    publish("channel.link.revoked", {
      issuer: ctx.ownerDid,
      subject: row.did,
      scope: CHANNEL_LINK_SCOPE,
      payload: {
        linkId: row.id,
        channel: row.channel,
        did: row.did,
        appDid: row.appDid,
        context_id: row.id,
        context_type: "channel_link",
      },
    }).catch((err: unknown) =>
      log.error(
        { err: String(err), linkId: row.id, assetId: ctx.assetId },
        "channel.link.revoked publish failed (non-fatal)",
      ),
    );
  }
}

/**
 * The connector scope-manifest projection surface. Plugs into the #1207 reactor
 * via {@link registerProjectionSurface}; gated to scope-manifest assets so it
 * never touches channel_links for articles/other documents.
 */
export const channelLinksSurface: ProjectionSurface = {
  name: "connector-channel-links",

  async apply(ctx, released) {
    const connector = await resolveManifestConnector(ctx);
    if (!connector) return; // Not a manifest (or unattributed) → no-op.

    const { appDid, channel } = connector;
    const releasedScopes = Object.keys(released);
    const releasedSet = new Set(releasedScopes);

    // GRANT: one ACTIVE row per released scope. Idempotent upsert on the
    // (channel, channelUid, appDid) pair — re-adding a previously-revoked scope
    // flips it back to active (re-grant).
    const now = new Date();
    for (const scope of releasedScopes) {
      await db
        .insert(channelLinks)
        .values({
          id: scopeLinkId(ctx.assetId, scope),
          channel,
          channelUid: scopeUid(ctx.assetId, scope),
          did: ctx.ownerDid,
          appDid,
          scopes: [scope],
          status: "active",
          createdAt: now,
          revokedAt: null,
        })
        .onConflictDoUpdate({
          target: [channelLinks.channel, channelLinks.channelUid, channelLinks.appDid],
          set: { scopes: [scope], status: "active", revokedAt: null },
        });
    }

    // FOOTPRINT-RECONCILE (closes the full-declaration-deletion gap for row
    // surfaces): revoke any ACTIVE row for THIS manifest asset whose scope is no
    // longer in the released set. This covers scopes whose entire declaration
    // was deleted from the manifest — the reactor cannot report those as
    // `removedFields` (it only knows fields still declared), so we detect them
    // by diffing the live rows against the current released footprint.
    const activeRows = await db
      .select({
        id: channelLinks.id,
        channel: channelLinks.channel,
        channelUid: channelLinks.channelUid,
        did: channelLinks.did,
        appDid: channelLinks.appDid,
      })
      .from(channelLinks)
      .where(
        and(
          eq(channelLinks.appDid, appDid),
          eq(channelLinks.status, "active"),
          like(channelLinks.channelUid, `${ctx.assetId}${SCOPE_UID_SEP}%`),
        ),
      );

    const stale = activeRows.filter((row) => {
      const scope = scopeFromUid(ctx.assetId, row.channelUid);
      return scope !== null && !releasedSet.has(scope);
    });
    await revokeLinkRows(ctx, stale);
  },

  async remove(ctx, removedFields) {
    if (removedFields.length === 0) return;
    const connector = await resolveManifestConnector(ctx);
    if (!connector) return; // Not a manifest → no-op.

    // REVOKE (#1208): for each removed scope with an ACTIVE row, flip it to
    // revoked + publish channel.link.revoked. Idempotent — the status='active'
    // filter means a scope that was never materialized (or already revoked by
    // the footprint-reconcile above) is a no-op (no write, no spurious revoke).
    const uids = removedFields.map((scope) => scopeUid(ctx.assetId, scope));
    const activeRows = await db
      .select({
        id: channelLinks.id,
        channel: channelLinks.channel,
        did: channelLinks.did,
        appDid: channelLinks.appDid,
      })
      .from(channelLinks)
      .where(
        and(
          eq(channelLinks.appDid, connector.appDid),
          eq(channelLinks.status, "active"),
          inArray(channelLinks.channelUid, uids),
        ),
      );

    await revokeLinkRows(ctx, activeRows);
  },
};

let registered = false;

/**
 * Register the connector scope-manifest surface with the #1207 projection
 * reactor. Idempotent, mirroring {@link ensureProjectReactorRegistered} —
 * called from the media write path (update-asset.ts) so the surface is present
 * before `document.changed` is published in the same process.
 */
export function ensureChannelLinksSurfaceRegistered(): void {
  if (registered) return;
  registerProjectionSurface(channelLinksSurface);
  registered = true;
  log.info({ surface: channelLinksSurface.name }, "Connector channel_links projection surface registered");
}
