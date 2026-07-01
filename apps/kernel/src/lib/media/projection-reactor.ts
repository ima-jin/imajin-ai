// Relative imports for the media siblings (not "@/") so they resolve under the
// test runner, which loads these modules for real rather than mocking them.
import { readFile } from "node:fs/promises";
import { createLogger } from "@imajin/logger";
import {
  broker,
  registerReactor,
  isBrokerRelease,
  type BusEvent,
  type BrokerRequest,
  type ReactorHandler,
} from "@imajin/bus";
import { db, assets } from "@/src/db";
import { eq } from "drizzle-orm";
import { parseReleasePolicy, type FieldReleasePolicy } from "./release-policy";

/**
 * Release-gated projection reactor (#1207, EPIC #1204) — the heart of the
 * pattern.
 *
 * On `document.changed` (#1205) this reactor reads the authored document at
 * `payload.path`, parses its per-field release policy (#1206), and for each
 * declared field runs the EXISTING broker consent→scope→release→audit latch
 * (`broker()` in packages/bus) to decide whether that field materializes into
 * its DB projection. Released fields land in their EXISTING home; gated fields
 * are NEVER written — we gate at projection time, upstream of query, so a value
 * that was never materialized cannot leak (Q2: no generic release-gated
 * projection table). The broker's audit reactor writes the `broker_audit_log`
 * row for every consent-gated decision for free.
 *
 * ── Import direction ────────────────────────────────────────────────────────
 * packages/bus MUST NOT import apps/kernel. This reactor lives on the KERNEL
 * side (it needs #1206's parseReleasePolicy and the kernel projection targets)
 * and registers itself with `registerReactor('project', ...)` from @imajin/bus
 * during the kernel media write path (see update-asset.ts), which is guaranteed
 * loaded before `document.changed` is published. DB writes use the kernel's
 * drizzle client; the broker call is the only bus surface consumed.
 */

const log = createLogger("kernel");

/**
 * Broker event type for the per-field projection decision. There is no
 * `bus_chain_configs` row for it, so `broker()` resolves the built-in default
 * chain (consent → scope → release → audit) — we reuse the latch unchanged.
 */
const PROJECTION_BROKER_TYPE = "document.project";

/** Declared purpose for the projection release decision (audited). */
const PROJECTION_PURPOSE = "document.projection";

/** Context handed to every projection surface for one `document.changed`. */
export interface ProjectionContext {
  /** The changed asset id (event.subject). */
  assetId: string;
  /** Owner DID (event.issuer). Owner-pinned by #1205 — the privileged actor. */
  ownerDid: string;
  /** Service scope (event.scope, e.g. "media"). */
  scope: string;
  /** Absolute path of the authored document on disk (payload.path). */
  path: string;
}

/**
 * A projection surface persists released field values into an EXISTING home
 * (Q2: `metadata.article`, `profile.profiles.field_visibility`, connector rows
 * — never a generic table). Gated fields are guaranteed ABSENT from `released`,
 * so a surface physically cannot leak them. Surfaces plug in via
 * {@link registerProjectionSurface} so #1209 (connector manifest → channel_links)
 * can add its own without touching the reactor core.
 */
export interface ProjectionSurface {
  readonly name: string;
  apply(ctx: ProjectionContext, released: Record<string, unknown>): Promise<void>;
}

/**
 * Representative surface (#1207): project released fields into the asset's
 * existing `metadata.article` projection home (#1193). The standard article
 * block (slug/title/status/date) is still re-derived by
 * `deriveArticleProjection()`; this only MERGES the release-gated declared
 * fields on top. Gated fields are never merged, so they are absent from the
 * projection and cannot be queried/leaked.
 */
export const articleMetadataSurface: ProjectionSurface = {
  name: "article-metadata",
  async apply(ctx, released) {
    // Nothing released → nothing to materialize (also avoids a needless write).
    if (Object.keys(released).length === 0) return;

    const [row] = await db
      .select({ metadata: assets.metadata })
      .from(assets)
      .where(eq(assets.id, ctx.assetId))
      .limit(1);

    const existing =
      row?.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const article =
      existing.article && typeof existing.article === "object"
        ? (existing.article as Record<string, unknown>)
        : {};

    const metadata = { ...existing, article: { ...article, ...released } };

    await db
      .update(assets)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(assets.id, ctx.assetId));
  },
};

/** Registered projection surfaces, in apply order. */
const surfaces: ProjectionSurface[] = [articleMetadataSurface];

/** Plug in an additional projection surface (e.g. #1209 connector rows). */
export function registerProjectionSurface(surface: ProjectionSurface): void {
  surfaces.push(surface);
}

/** A single field's release decision. */
type FieldDecision = { release: true; value: unknown } | { release: false };

/**
 * Decide whether a single field materializes, mapping the #1206 release tier to
 * the broker latch:
 *
 *   never       → structural drop. The policy seals it; we never even ask the
 *                 broker and never materialize (strongest gate, rule 2).
 *   silent      → freely projectable (self & not sensitive). Public — no consent
 *                 required (mirrors #1003 "no rule = public pass-through").
 *   on-consent  → run broker() for the declared `viewer` scope; materialize iff
 *                 released.
 *   owner-only  → run broker() with the owner as the only permitted viewer; in a
 *                 shared projection home this releases only to the owner, so it is
 *                 gated out of any non-owner projection.
 *
 * All consent-gated tiers reuse `broker()` unchanged; its audit reactor records
 * the decision. Fail-closed: a rejection (or a value the broker filtered out)
 * yields `{ release: false }`.
 */
async function decideFieldRelease(
  ctx: ProjectionContext,
  field: string,
  value: unknown,
  policy: FieldReleasePolicy,
): Promise<FieldDecision> {
  switch (policy.release) {
    case "never":
      return { release: false };
    case "silent":
      return { release: true, value };
    case "on-consent":
    case "owner-only": {
      const requester =
        policy.release === "owner-only" ? ctx.ownerDid : policy.viewer ?? ctx.ownerDid;
      const request: BrokerRequest = {
        type: PROJECTION_BROKER_TYPE,
        requester,
        subject: ctx.ownerDid,
        fields: [field],
        purpose: PROJECTION_PURPOSE,
        scope: ctx.scope,
        data: { [field]: value },
      };
      const result = await broker(PROJECTION_BROKER_TYPE, request);
      if (isBrokerRelease(result) && field in result.data) {
        return { release: true, value: result.data[field] };
      }
      return { release: false };
    }
  }
}

/**
 * The `project` reactor handler. Best-effort/non-fatal: the file is the signed
 * source of truth, so any failure self-heals on the next edit rather than
 * corrupting the projection.
 */
export const projectReactor: ReactorHandler = async (event: BusEvent) => {
  const payload = event.payload as { path?: string } | undefined;
  const path = payload?.path;
  if (!path) {
    log.warn({ event: event.type, subject: event.subject }, "project reactor: missing payload.path");
    return;
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    log.error({ err: String(err), path }, "project reactor: could not read document");
    return;
  }

  const parsed = parseReleasePolicy(content);
  if ("error" in parsed) {
    // Fail-closed (rule 2): a malformed/over-broad release header projects
    // NOTHING rather than materializing an unvalidated claim.
    log.warn(
      { err: parsed.error, subject: event.subject },
      "project reactor: invalid release policy; projecting nothing",
    );
    return;
  }

  const { releasePolicy, data } = parsed;
  const fields = Object.keys(releasePolicy);
  if (fields.length === 0) return; // No gated fields declared → no-op.

  const ctx: ProjectionContext = {
    assetId: event.subject,
    ownerDid: event.issuer,
    scope: event.scope,
    path,
  };

  const released: Record<string, unknown> = {};
  for (const field of fields) {
    const value = data[field];
    if (value === undefined) continue; // Declared but absent in truth-data → nothing to project.
    const decision = await decideFieldRelease(ctx, field, value, releasePolicy[field]);
    if (decision.release) {
      released[field] = decision.value;
    }
    // Gated fields are simply never added → ABSENT from the projection.
  }

  for (const surface of surfaces) {
    try {
      await surface.apply(ctx, released);
    } catch (err) {
      log.error(
        { err: String(err), surface: surface.name, assetId: ctx.assetId },
        "projection surface failed (non-fatal)",
      );
    }
  }
};

let registered = false;

/**
 * Register the `project` reactor with the bus registry. Idempotent, mirroring
 * `ensureVaultHotReloadReactorRegistered()` — called from the media write path
 * (update-asset.ts) so it is guaranteed registered before `document.changed`
 * is published in the same process.
 */
export function ensureProjectReactorRegistered(): void {
  if (registered) return;
  registerReactor("project", projectReactor);
  registered = true;
  log.info({ reactor: "project" }, "Release-gated projection reactor registered");
}
