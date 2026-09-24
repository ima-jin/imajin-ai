import { NextRequest, NextResponse } from "next/server";
import { db, identities } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { corsHeaders, corsOptions } from "@/src/lib/kernel/cors";
import { eq } from "drizzle-orm";
import { rateLimit, getClientIP } from "@imajin/config";
import { createLogger } from "@imajin/logger";
import { inferMime, isAllowedMime, type AssetContext } from "@/src/lib/media/create-asset";
import { getUploadLimitBytes } from "@/src/lib/media/upload-limits";
import { processBundleUpload, type BundleFileInput } from "@/src/lib/media/bundle-upload";
import { articleWarningFields } from "@/src/lib/media/article-guard";

const log = createLogger("kernel");

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface ParsedBundle {
  files: BundleFileInput[];
  indexPath: string;
  indexAssetId?: string;
  context: AssetContext | null;
  strict: boolean;
}

type ParseBundleResult = { ok: true; bundle: ParsedBundle } | { ok: false; status: number; error: string };

/**
 * Parse the bundle multipart body: N `files` entries (each `File.name` is the
 * bundle-relative path referenced by the index doc), plus optional `index`
 * (names the markdown entry when it can't be inferred), `indexAssetId`
 * (update semantics — see bundle-upload.ts), `context`, and `strict`.
 */
async function parseBundleFormData(formData: FormData): Promise<ParseBundleResult> {
  const entries = formData.getAll("files").filter((v): v is File => v instanceof Blob);
  if (entries.length === 0) {
    return { ok: false, status: 400, error: "At least one file is required (field: files)" };
  }

  const files: BundleFileInput[] = [];
  for (const entry of entries) {
    const path = entry.name || `file_${files.length}`;
    const buffer = Buffer.from(await entry.arrayBuffer());
    const mimeType = inferMime(entry.type, path);
    files.push({ path, buffer, mimeType });
  }

  const indexField = formData.get("index");
  let indexPath: string;
  if (typeof indexField === "string" && indexField) {
    indexPath = indexField;
  } else {
    const markdownFiles = files.filter((f) => f.mimeType === "text/markdown");
    if (markdownFiles.length !== 1) {
      return {
        ok: false,
        status: 400,
        error: "Cannot determine the index entry — specify the `index` field naming the markdown file",
      };
    }
    indexPath = markdownFiles[0].path;
  }
  if (!files.some((f) => f.path === indexPath)) {
    return { ok: false, status: 400, error: `index file "${indexPath}" not found among uploaded files` };
  }

  const indexAssetIdRaw = formData.get("indexAssetId");
  const indexAssetId = typeof indexAssetIdRaw === "string" && indexAssetIdRaw ? indexAssetIdRaw : undefined;

  let context: AssetContext | null = null;
  const contextRaw = formData.get("context");
  if (typeof contextRaw === "string" && contextRaw) {
    try {
      context = JSON.parse(contextRaw);
    } catch {
      /* ignore bad JSON */
    }
  }

  const strictRaw = formData.get("strict");
  const strict = strictRaw === "true" || strictRaw === "1";

  return { ok: true, bundle: { files, indexPath, indexAssetId, context, strict } };
}

// ---------------------------------------------------------------------------
// POST /media/api/assets/bundle — upload N files + a markdown index doc,
// rewriting the index's local refs to the uploaded assets' URLs (#2282).
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, "Retry-After": String(rl.retryAfter) } },
    );
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const ownerDid = resolveActingDid(identity);
  const uploadedBy = identity.id;

  const [identityRow] = await db
    .select({ tier: identities.tier, uploadLimitMb: identities.uploadLimitMb })
    .from(identities)
    .where(eq(identities.id, identity.id))
    .limit(1);
  const uploadLimitBytes = getUploadLimitBytes(identityRow ?? { tier: identity.tier });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart data" }, { status: 400, headers: cors });
  }

  const parsed = await parseBundleFormData(formData);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status, headers: cors });
  }
  const { files, indexPath, indexAssetId, context, strict } = parsed.bundle;

  const totalBytes = files.reduce((sum, f) => sum + f.buffer.byteLength, 0);
  if (totalBytes > uploadLimitBytes) {
    const limitMb = Math.round(uploadLimitBytes / (1024 * 1024));
    return NextResponse.json({ error: `Bundle exceeds ${limitMb} MB limit` }, { status: 413, headers: cors });
  }

  for (const file of files) {
    if (!isAllowedMime(file.mimeType)) {
      return NextResponse.json(
        { error: `MIME type ${file.mimeType} is not allowed for ${file.path}` },
        { status: 415, headers: cors },
      );
    }
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || new URL(request.url).origin;

  const result = await processBundleUpload({
    ownerDid,
    uploadedBy,
    files,
    indexPath,
    indexAssetId,
    context,
    strict,
    baseUrl,
  });

  if (!result.ok) {
    log.error({ error: result.error, status: result.status }, "Bundle upload failed");
    return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
  }

  return NextResponse.json(
    {
      assets: result.assets,
      index: result.index,
      rewritten: result.rewritten,
      ...(result.unresolved.length > 0 ? { unresolved: result.unresolved } : {}),
      ...articleWarningFields(result.articleWarning),
    },
    { status: 201, headers: cors },
  );
}
