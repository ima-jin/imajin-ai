import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import * as bus from "@imajin/bus";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

const SLUG_REGEX = /^[a-z0-9-]+$/;
const VALID_STATUSES = ["POSTED", "REVIEW", "DRAFT"] as const;
type ArticleStatus = (typeof VALID_STATUSES)[number];

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
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

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

  if (!body.slug || typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug)) {
    return NextResponse.json(
      { error: "slug is required and must be URL-safe (a-z, 0-9, hyphens only)" },
      { status: 400, headers: cors }
    );
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json(
      { error: "title is required" },
      { status: 400, headers: cors }
    );
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

  // 4. Validate mime type
  if (asset.mimeType !== "text/markdown") {
    return NextResponse.json(
      { error: "Asset must be text/markdown to publish as an article" },
      { status: 400, headers: cors }
    );
  }

  // 5. Merge article block into metadata
  const existingMetadata =
    asset.metadata && typeof asset.metadata === "object" ? (asset.metadata as Record<string, unknown>) : {};

  const articleBlock = {
    slug: body.slug,
    title: body.title.trim(),
    subtitle: typeof body.subtitle === "string" ? body.subtitle.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    status,
    date,
    ...(order === undefined  ? {} : { order }),
  };

  const metadata = {
    ...existingMetadata,
    article: articleBlock,
  };

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
        slug: body.slug,
        title: body.title.trim(),
        status,
        date,
      },
    });
  } catch (err) {
    log.error({ err: String(err), assetId: id }, "Bus event publish failed (non-fatal)");
  }

  // 8. Return updated asset
  const [updated] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return NextResponse.json(updated, { status: 200, headers: cors });
}
