/**
 * Shared, dependency-free article constants (#1445).
 *
 * Split out of article-core.ts so client components (e.g. the metadata badge
 * / editor in the asset viewer) can import the validation rules without
 * pulling in article-core's server-only "@/src/db" dependency into the
 * browser bundle. article-core.ts re-exports these so existing server-side
 * imports are unaffected.
 */

export const SLUG_REGEX = /^[a-z0-9-]+$/;
export const VALID_STATUSES = ["POSTED", "REVIEW", "DRAFT"] as const;
export type ArticleStatus = (typeof VALID_STATUSES)[number];
