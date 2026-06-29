import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import * as bus from "@imajin/bus";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

export const SLUG_REGEX = /^[a-z0-9-]+$/;
export const VALID_STATUSES = ["POSTED", "REVIEW", "DRAFT"] as const;
export type ArticleStatus = (typeof VALID_STATUSES)[number];

/** Raw article fields as received from a request body or tool args. */
export interface ArticleInput {
  slug?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
  status?: unknown;
  date?: unknown;
  order?: unknown;
}

/** A validated, normalized article metadata block. */
export interface ArticleBlock {
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  status: ArticleStatus;
  date: string;
  order?: number;
}

/**
 * Validate + normalize article fields into a metadata block. Returns the block
 * or a human-readable error (the exact messages the HTTP route surfaces). Shared
 * by patchArticle (HTTP) and the media_create_text MCP tool (#1170).
 */
export function buildArticleBlock(body: ArticleInput): { block: ArticleBlock } | { error: string } {
  if (!body.slug || typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug)) {
    return { error: "slug is required and must be URL-safe (a-z, 0-9, hyphens only)" };
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return { error: "title is required" };
  }

  const status: ArticleStatus =
    body.status && VALID_STATUSES.includes(body.status as ArticleStatus)
      ? (body.status as ArticleStatus)
      : "POSTED";

  const date =
    body.date && typeof body.date === "string"
      ? body.date
      : new Date().toISOString().split("T")[0];

  const order = typeof body.order === "number" ? body.order : undefined;

  const block: ArticleBlock = {
    slug: body.slug,
    title: body.title.trim(),
    subtitle: typeof body.subtitle === "string" ? body.subtitle.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    status,
    date,
    ...(order === undefined ? {} : { order }),
  };
  return { block };
}

/** Merge a validated article block into an asset's existing metadata object. */
export function mergeArticleMetadata(existing: unknown, block: ArticleBlock): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  return { ...base, article: block };
}

export async function patchArticle(
  request: NextRequest,
  id: string
): Promise<NextResponse> {
  const cors = corsHeaders(request);

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }
  const requesterDid = resolveActingDid(authResult.identity);

  // 2. Parse body
  let body: {
    slug?: unknown;
    title?: unknown;
    subtitle?: unknown;
    description?: unknown;
    status?: unknown;
    date?: unknown;
    order?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  const built = buildArticleBlock(body);
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400, headers: cors });
  }
  const article = built.block;

  // 3. Load asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json(
      { error: "Database failure" },
      { status: 500, headers: cors }
    );
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cors });
  }

  // Immutability guard
  if (asset.immutable) {
    return NextResponse.json({ error: "Immutable asset — article metadata cannot be modified" }, { status: 403, headers: cors });
  }

  // 4. Validate mime type
  if (asset.mimeType !== "text/markdown") {
    return NextResponse.json(
      { error: "Asset must be text/markdown to publish as an article" },
      { status: 400, headers: cors }
    );
  }

  // 5. Merge article block into metadata
  const metadata = mergeArticleMetadata(asset.metadata, article);

  // 6. Update DB
  try {
    await db
      .update(assets)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(assets.id, id));
  } catch (err) {
    log.error({ err: String(err), assetId: id }, "DB update failed");
    return NextResponse.json(
      { error: "Database update failed" },
      { status: 500, headers: cors }
    );
  }

  // 7. Emit bus event (best-effort)
  try {
    await bus.publish("asset.article.published", {
      issuer: requesterDid,
      subject: asset.ownerDid,
      scope: "media",
      payload: {
        assetId: id,
        slug: article.slug,
        title: article.title,
        status: article.status,
        date: article.date,
      },
    });
  } catch (err) {
    log.error({ err: String(err), assetId: id }, "Bus event publish failed (non-fatal)");
  }

  // 8. Return updated asset
  const [updated] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return NextResponse.json(updated, { status: 200, headers: cors });
}
