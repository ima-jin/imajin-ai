import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import * as bus from "@imajin/bus";
import { corsHeaders } from "@/src/lib/kernel/cors";
import { buildArticleBlock, type ArticleInput } from "../article-core";
import { composeArticleFile, parseFrontmatter } from "../frontmatter";
import { updateAssetContent } from "@/src/lib/media/update-asset";

const log = createLogger("kernel");

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
  let body: ArticleInput;
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

  // 5. Read the current file body — frontmatter is regenerated, body preserved.
  let currentBody = "";
  try {
    const raw = await readFile(asset.storagePath, "utf-8");
    currentBody = parseFrontmatter(raw).body;
  } catch (err) {
    log.warn(
      { err: String(err), assetId: id },
      "Could not read current article file; writing frontmatter with empty body"
    );
  }

  // 6. Write frontmatter into the file as a new version. The shared content-write
  //    path re-derives metadata.article from the bytes we just wrote, so the DB
  //    projection is never updated independently (single direction of truth).
  const result = await updateAssetContent({
    assetId: id,
    requesterDid,
    content: composeArticleFile(article, currentBody),
    requireTextMime: true,
  });
  if (!result.ok) {
    const statusByCode = {
      not_found: 404,
      forbidden: 403,
      immutable: 403,
      unsupported_media: 400,
      storage_failed: 500,
      db_failed: 500,
    } as const;
    return NextResponse.json({ error: result.message }, { status: statusByCode[result.code], headers: cors });
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

  // 8. Return updated asset (metadata.article already re-derived on write).
  return NextResponse.json(result.asset, { status: 200, headers: cors });
}
