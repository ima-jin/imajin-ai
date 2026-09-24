/**
 * Data-driven notify templates (#1510) — `getTemplate(scope)` reads the
 * `notify.templates` row for a scope (in-memory cache + bus hot-reload on
 * `notify.template.updated`) and falls back to the in-code registry
 * (`./templates.ts`) whenever no row exists, the row is disabled, or the
 * DB lookup itself fails. The fallback is not just a migration safety net —
 * it is the deliberate rollout gate: a scope's row can be backfilled and
 * reviewed with zero runtime effect until an operator flips `enabled` (a
 * config change, not a deploy — the whole point of #1510).
 *
 * `NotifyTemplate` (the shape both a DB row and an in-code entry resolve
 * to) is unchanged from `./templates.ts` so the two callers of
 * `getTemplate` — `POST /notify/api/send` and `connector-events.ts` — need
 * no shape-specific branching, only an `await`.
 */
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { registerReactor, type BusEvent, type ReactorHandler } from "@imajin/bus";
import { db, notifyTemplates } from "@/src/db";
import { emailWrapper } from "@imajin/email";
import { getTemplate as getCodeTemplate, type NotifyTemplate } from "./templates";
import { renderPlainTemplate, renderHtmlTemplate } from "./template-renderer";

const log = createLogger("kernel");

const NOTIFY_TEMPLATE_HOT_RELOAD_REACTOR = "notify-template-hot-reload";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface NotifyTemplateRow {
  scope: string;
  urgency: "low" | "normal" | "urgent";
  subjectTpl: string;
  bodyTpl: string;
  htmlTpl: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// In-memory cache, keyed by scope. Mirrors packages/bus/src/config.ts's
// TTL-cache shape; `invalidateNotifyTemplateCache` (below) additionally
// drops an entry immediately on the bus hot-reload event, so a config edit
// does not have to wait out the TTL.
// ---------------------------------------------------------------------------

interface CacheEntry {
  row: NotifyTemplateRow | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(scope: string): NotifyTemplateRow | null | undefined {
  const entry = cache.get(scope);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(scope);
    return undefined;
  }
  return entry.row;
}

function setCached(scope: string, row: NotifyTemplateRow | null): void {
  cache.set(scope, { row, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Drop the cached entry for `scope` so the next {@link getTemplate} call re-reads the DB. */
export function invalidateNotifyTemplateCache(scope: string): void {
  cache.delete(scope);
}

/** Test-only: force every scope back to a cold cache. */
export function clearNotifyTemplateCacheForTests(): void {
  cache.clear();
}

async function fetchTemplateRow(scope: string): Promise<NotifyTemplateRow | null> {
  try {
    const rows = await db.select().from(notifyTemplates).where(eq(notifyTemplates.scope, scope)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      scope: row.scope,
      urgency: (row.urgency as NotifyTemplateRow["urgency"]) || "normal",
      subjectTpl: row.subjectTpl,
      bodyTpl: row.bodyTpl,
      htmlTpl: row.htmlTpl,
      enabled: row.enabled,
    };
  } catch (err) {
    log.warn({ err: String(err), scope }, "notify.templates lookup failed; falling back to in-code registry");
    return null;
  }
}

/**
 * Wrap a rendered CTA/body HTML fragment in the same dark-theme card shell
 * every in-code template already uses (`simpleEmailHtml` in templates.ts) —
 * kept identical here so a scope's email looks the same whether its
 * `NotifyTemplate` came from a DB row or the code fallback.
 */
function wrapEmailHtml(title: string, bodyHtml: string): string {
  return emailWrapper(`
    <tr>
      <td style="background-color:#111111;border-radius:8px 8px 0 0;padding:32px 32px 24px;">
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${title}</h1>
        <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">${bodyHtml}</p>
      </td>
    </tr>
    <tr>
      <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
        <div style="border-top:1px solid #262626;padding-top:20px;"></div>
      </td>
    </tr>
  `);
}

function toNotifyTemplate(row: NotifyTemplateRow): NotifyTemplate {
  return {
    scope: row.scope,
    urgency: row.urgency,
    title: (data) => renderPlainTemplate(row.subjectTpl, data),
    body: (data) => renderPlainTemplate(row.bodyTpl, data),
    email: row.htmlTpl
      ? {
          subject: (data) => renderPlainTemplate(row.subjectTpl, data),
          // The `<h1>` title uses the same `{{field}}` interpolation as the
          // subject, but through the HTML renderer (it lands inside markup,
          // not a header) — the CTA construct is never expected in a title,
          // but renderHtmlTemplate() is safe regardless if one appears.
          html: (data) => wrapEmailHtml(renderHtmlTemplate(row.subjectTpl, data), renderHtmlTemplate(row.htmlTpl as string, data)),
        }
      : undefined,
  };
}

/**
 * Resolve the notify template for `scope`: the DB row when one exists and
 * is enabled, otherwise the in-code registry entry (`./templates.ts`).
 */
export async function getTemplate(scope: string): Promise<NotifyTemplate | undefined> {
  let row = getCached(scope);
  if (row === undefined) {
    row = await fetchTemplateRow(scope);
    setCached(scope, row);
  }
  if (row?.enabled) return toNotifyTemplate(row);
  return getCodeTemplate(scope);
}

// ---------------------------------------------------------------------------
// Bus hot-reload (#1510) — `notify.template.updated` invalidates the cache
// entry for the affected scope immediately, mirroring the
// `vault-hot-reload` precedent (apps/kernel/src/lib/vault/subscribe.ts).
// No publisher exists yet in this PR (the admin surface that would edit a
// row is an explicit stretch goal) — this wires the consumer side so a
// future admin write path only has to `publish('notify.template.updated',
// ...)` to get live invalidation for free.
// ---------------------------------------------------------------------------

function extractScope(event: BusEvent): string | null {
  const scope = event.payload?.scope;
  return typeof scope === "string" && scope.length > 0 ? scope : null;
}

const notifyTemplateHotReloadReactor: ReactorHandler = async (event) => {
  const scope = extractScope(event);
  if (!scope) {
    log.warn({ type: event.type }, "notify.template.updated missing payload.scope — nothing to invalidate");
    return;
  }
  invalidateNotifyTemplateCache(scope);
  log.debug({ scope }, "notify.templates cache invalidated by notify.template.updated");
};

let reactorRegistered = false;

/**
 * Idempotent — safe to call from every importer, mirrors
 * `ensureVaultHotReloadReactorRegistered`. Registered eagerly below rather
 * than from one "owning" route (unlike vault's set/rotate routes) because
 * this module is imported transitively by many connector implementations
 * via connector-events.ts — there is no single natural call site, and no
 * publisher of `notify.template.updated` ships in this PR yet anyway.
 * Wrapped in try/catch: registration is a nice-to-have (the TTL cache alone
 * still bounds staleness to `CACHE_TTL_MS`), so a test suite that mocks
 * `@imajin/bus` without `registerReactor` — unrelated to notify templates
 * entirely — must not fail merely by importing this module.
 */
export function ensureNotifyTemplateHotReloadReactorRegistered(): void {
  if (reactorRegistered) return;
  try {
    registerReactor(NOTIFY_TEMPLATE_HOT_RELOAD_REACTOR, notifyTemplateHotReloadReactor);
    reactorRegistered = true;
    log.info({ reactor: NOTIFY_TEMPLATE_HOT_RELOAD_REACTOR }, "Notify-template hot-reload reactor registered");
  } catch (err) {
    log.warn(
      { err: String(err) },
      "Could not register notify-template-hot-reload reactor — hot-reload disabled, TTL cache still applies",
    );
  }
}

ensureNotifyTemplateHotReloadReactorRegistered();
