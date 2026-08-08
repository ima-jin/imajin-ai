import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, assets, identities } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { corsHeaders, corsOptions } from "@/src/lib/kernel/cors";
import { eq, and, sql, ilike, like } from "drizzle-orm";
import { rateLimit, getClientIP } from "@imajin/config";
import { createLogger } from "@imajin/logger";
import { createAsset, inferMime, isAllowedMime, type AssetContext } from "@/src/lib/media/create-asset";
import {
  articleWarningFields,
  checkArticleFrontmatter,
  type ArticleFrontmatterCheck,
} from "@/src/lib/media/article-guard";

const log = createLogger("kernel");

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

const TIER_LIMITS: Record<string, number> = {
  soft: 50,
  preliminary: 50,
  established: 200,
};

function getUploadLimitBytes(identity: { tier?: string; uploadLimitMb?: number | null }): number {
  const mb = identity.uploadLimitMb ?? TIER_LIMITS[identity.tier || 'soft'] ?? 50;
  return mb * 1024 * 1024;
}

/** Resolve (and optionally rename) the upload filename. */
function resolveUploadFilename(file: Blob, formData: FormData): string {
  const GENERIC_AUDIO_PATTERN = /^(voice|blob|audio|recording|sound)\./i;
  const base =
    (formData.get("filename") as string | null) ??
    (file as File).name ??
    "upload";
  if (file.type.startsWith("audio/") && GENERIC_AUDIO_PATTERN.test(base)) {
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
    return `Audio_${ts.getFullYear()}_${pad(ts.getMonth() + 1)}_${pad(ts.getDate())}_${pad(ts.getHours())}_${pad(ts.getMinutes())}_${pad(ts.getSeconds())}${ext}`;
  }
  return base;
}

/**
 * Article frontmatter guard for the upload path (#1542).
 *
 * An article-context markdown upload with no usable `---` header projects to
 * `metadata.article = null` and silently becomes a plain note. The projection is
 * unchanged — this only stops it from being silent. Returns a 400 response when
 * the caller opted into the hard gate with the `strict` multipart field, else
 * the warning to attach to the success response (or null when all is well).
 *
 * Plain notes (no article context) never trip this.
 */
function guardArticleUpload(input: {
  mimeType: string;
  buffer: Buffer;
  context: AssetContext | null;
  formData: FormData;
  filename: string;
  cors: Record<string, string>;
}): NextResponse | ArticleFrontmatterCheck | null {
  const { mimeType, buffer, context, formData, filename, cors } = input;
  // Markdown-gated up front so a large binary is never decoded to a string.
  if (mimeType !== "text/markdown") return null;

  const check = checkArticleFrontmatter({ mimeType, content: buffer.toString("utf8"), context });
  if (!check) return null;

  const strict = formData.get("strict");
  if (strict === "true" || strict === "1") {
    return NextResponse.json(
      { error: check.warning, articleProjection: null },
      { status: 400, headers: cors }
    );
  }

  log.warn({ filename, reason: check.reason }, "Article-context markdown upload has no usable frontmatter");
  return check;
}

/** Resolve ownerDid for GET /api/assets listing: internal key path or user auth path. */
async function resolveListOwnerDid(
  request: NextRequest,
  searchParams: URLSearchParams,
  cors: Record<string, string>
): Promise<{ ownerDid: string; isAgentQuery: boolean } | NextResponse> {
  const internalApiKey = process.env.MEDIA_INTERNAL_API_KEY;
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (
    bearerToken &&
    internalApiKey &&
    bearerToken.length === internalApiKey.length &&
    timingSafeEqual(Buffer.from(bearerToken), Buffer.from(internalApiKey))
  ) {
    const ownerDidHeader = request.headers.get("X-Owner-DID");
    if (!ownerDidHeader) {
      return NextResponse.json({ error: "X-Owner-DID header required" }, { status: 400, headers: cors });
    }
    return { ownerDid: ownerDidHeader, isAgentQuery: false };
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const didParam = searchParams.get("did");
  if (didParam && didParam !== identity.id) {
    return { ownerDid: didParam, isAgentQuery: true };
  }
  return { ownerDid: resolveActingDid(identity), isAgentQuery: false };
}

// ---------------------------------------------------------------------------
// POST /api/assets — upload a file
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, "Retry-After": String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const ownerDid = resolveActingDid(identity);
  const uploadedBy = identity.id;

  // Fetch full identity row to get uploadLimitMb
  const [identityRow] = await db
    .select({ tier: identities.tier, uploadLimitMb: identities.uploadLimitMb })
    .from(identities)
    .where(eq(identities.id, identity.id))
    .limit(1);
  const uploadLimitBytes = getUploadLimitBytes(identityRow ?? { tier: identity.tier });

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  // Size check
  const limitMb = Math.round(uploadLimitBytes / (1024 * 1024));
  if (file.size > uploadLimitBytes) {
    return NextResponse.json(
      { error: `File exceeds ${limitMb} MB limit` },
      { status: 413 }
    );
  }

  // Extract original filename first (needed for MIME inference);
  // generic audio blobs are renamed to a timestamped format.
  const originalName = resolveUploadFilename(file, formData);

  // MIME check — infer from extension if browser sent octet-stream
  const mimeType = inferMime(file.type, originalName);
  if (!isAllowedMime(mimeType)) {
    return NextResponse.json(
      { error: `MIME type ${mimeType} is not allowed` },
      { status: 415 }
    );
  }

  // Parse optional context (for auto-folder assignment + access override)
  let context: { app?: string; feature?: string; entityId?: string; access?: string } | null = null;
  const contextRaw = formData.get("context");
  if (contextRaw && typeof contextRaw === "string") {
    try { context = JSON.parse(contextRaw); } catch { /* ignore bad JSON */ }
  }

  // Read file bytes and hand off to the shared create pipeline (#1170). The
  // route owns HTTP concerns (auth, multipart, tier/size, MIME inference);
  // createAsset owns hashing/CID, dedup, storage, .fair signing, DB insert,
  // DFOS anchor, auto-folder, and classification.
  const buffer = Buffer.from(await file.arrayBuffer());

  // #1542 — run before createAsset so `strict` rejects without storing anything.
  const guard = guardArticleUpload({ mimeType, buffer, context, formData, filename: originalName, cors });
  if (guard instanceof NextResponse) return guard;
  const articleWarning = guard;

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || new URL(request.url).origin;

  let result;
  try {
    result = await createAsset({
      ownerDid,
      uploadedBy,
      buffer,
      filename: originalName,
      mimeType,
      context,
      baseUrl,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Asset creation failed");
    return NextResponse.json(
      { error: "Storage failure", detail: String(err) },
      { status: 500, headers: cors }
    );
  }

  const { asset, deduplicated } = result;
  const url = `${baseUrl}/media/api/assets/${asset.id}`;

  if (deduplicated) {
    // Existing asset returned on content match (CID-global or hash+owner).
    return NextResponse.json(
      {
        id: asset.id,
        url,
        filename: asset.filename,
        mimeType: asset.mimeType,
        size: asset.size,
        hash: asset.hash,
        ...(asset.cid ? { cid: asset.cid } : {}),
        deduplicated: true,
        ...articleWarningFields(articleWarning),
      },
      { status: 200, headers: cors }
    );
  }

  return NextResponse.json(
    {
      id: asset.id,
      url,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      hash: asset.hash,
      storagePath: asset.storagePath,
      fairManifest: asset.fairManifest,
      createdAt: asset.createdAt,
      ...articleWarningFields(articleWarning),
    },
    { status: 201, headers: cors }
  );
}

// ---------------------------------------------------------------------------
// GET /api/assets — list assets for authenticated user (or via internal API key)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const { searchParams } = new URL(request.url);
  const ownerInfo = await resolveListOwnerDid(request, searchParams, cors);
  if (ownerInfo instanceof NextResponse) return ownerInfo;
  const { ownerDid, isAgentQuery } = ownerInfo;

  const search = searchParams.get("search");      // filename search
  const type = searchParams.get("type");          // e.g. "image"
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(Number.parseInt(searchParams.get("limit") || "50", 10), 200);
  const offset = Number.parseInt(searchParams.get("offset") || "0", 10);

  try {
    const { desc: drizzleDesc, asc: drizzleAsc } = await import("drizzle-orm");

    // Build where conditions
    const conditions = [eq(assets.ownerDid, ownerDid), eq(assets.status, "active")];

    // If querying another DID's assets, restrict to public ones
    if (isAgentQuery) {
      // Public = fairManifest->access->>type = 'public' OR no access restriction set
      conditions.push(
        sql`COALESCE((${assets.fairManifest}->'access'->>'type'), 'private') = 'public'`
      );
    }

    // DB-level MIME prefix and filename filters
    if (type) conditions.push(like(assets.mimeType, `${type}/%`));
    if (search) conditions.push(ilike(assets.filename, `%${search}%`));

    const rows = await db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(
        order === "asc"
          ? drizzleAsc(assets.createdAt)
          : drizzleDesc(assets.createdAt)
      )
      .limit(limit)
      .offset(offset);

    return NextResponse.json({ assets: rows, limit, offset, count: rows.length }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, "DB query failed");
    return NextResponse.json(
      { error: "Database failure", detail: String(err) },
      { status: 500, headers: cors }
    );
  }
}
