/**
 * Placeholder callback-URL repair (#2746) — pure planning + the runner, kept
 * apart from the CLI entrypoint (`scripts/fix-placeholder-callback-urls.mjs`)
 * so both are unit-testable without a database.
 *
 * `apps.provision` used to register every app with
 * `callback_url = https://your-node.imajin.ai/<slug>`, and migration 0139
 * seeded the legacy first-party rows with the same host. `callback_url` is the
 * sign-in redirect target, and migration 0159 copied it into `redirect_uris`,
 * so BOTH columns carry the placeholder for those rows.
 */

export const PLACEHOLDER_HOST = 'your-node.imajin.ai';

const PLACEHOLDER_ORIGIN = /^https?:\/\/your-node\.imajin\.ai(?::\d+)?(?=[/?#]|$)/;

/** Rewrite a URL's placeholder origin to `origin`; null when it does not use the placeholder host. */
export function rewritePlaceholderUrl(url, origin) {
  if (typeof url !== 'string' || !PLACEHOLDER_ORIGIN.test(url)) return null;
  return url.replace(PLACEHOLDER_ORIGIN, origin);
}

/**
 * Normalise an operator-supplied node URL to a bare origin, refusing anything
 * unusable (unparseable, non-http(s), or the placeholder itself).
 */
export function parseNodeOrigin(value) {
  if (!value) throw new Error('no node public URL given (pass --origin <url>, or set APP_URL / NEXT_PUBLIC_BASE_URL)');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`node public URL is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`node public URL must be http(s): ${value}`);
  }
  if (parsed.hostname === PLACEHOLDER_HOST) {
    throw new Error(`node public URL is itself the placeholder host (${PLACEHOLDER_HOST})`);
  }
  return parsed.origin;
}

/** The fix for one `registry.apps` row, or null when it carries no placeholder. */
export function planRowFix(row, origin) {
  const callbackTo = rewritePlaceholderUrl(row.callback_url, origin);
  const redirectUris = Array.isArray(row.redirect_uris) ? row.redirect_uris : [];
  const redirectTo = redirectUris.map((uri) => rewritePlaceholderUrl(uri, origin) ?? uri);
  const redirectChanged = redirectTo.some((uri, i) => uri !== redirectUris[i]);
  if (callbackTo === null && !redirectChanged) return null;
  return {
    id: row.id,
    slug: row.slug ?? null,
    tier: row.tier ?? null,
    callbackUrl: { from: row.callback_url, to: callbackTo ?? row.callback_url },
    redirectUris: { from: redirectUris, to: redirectTo, changed: redirectChanged },
  };
}

function describeFix(fix) {
  const lines = [`  ${fix.id} (slug=${fix.slug ?? '-'}, tier=${fix.tier ?? '-'})`];
  lines.push(`    callback_url: ${fix.callbackUrl.from} -> ${fix.callbackUrl.to}`);
  if (fix.redirectUris.changed) {
    lines.push(`    redirect_uris: ${JSON.stringify(fix.redirectUris.from)} -> ${JSON.stringify(fix.redirectUris.to)}`);
  }
  return lines.join('\n');
}

/**
 * Find every `registry.apps` row still carrying the placeholder host and, with
 * `apply`, rewrite it to `origin` in one transaction. Dry-run by default.
 * Always prints each row it would touch / touched. Returns the planned fixes.
 */
export async function fixPlaceholderCallbackUrls({ sql, origin, apply = false, log = console.log }) {
  const pattern = `%://${PLACEHOLDER_HOST}%`;
  const rows = await sql`
    SELECT id, slug, tier, callback_url, redirect_uris
    FROM registry.apps
    WHERE callback_url LIKE ${pattern}
       OR array_to_string(redirect_uris, ',') LIKE ${pattern}
    ORDER BY id
  `;
  const fixes = rows.map((row) => planRowFix(row, origin)).filter((fix) => fix !== null);

  log(`node origin: ${origin}`);
  log(`${fixes.length} registry.apps row(s) with the ${PLACEHOLDER_HOST} placeholder:`);
  for (const fix of fixes) log(describeFix(fix));

  if (!apply) {
    log(fixes.length > 0 ? '\nDRY RUN — nothing written. Re-run with --apply to update these rows.' : '\nNothing to do.');
    return fixes;
  }

  if (fixes.length > 0) {
    // The updates pipeline on the transaction's single connection; any failure rolls all of them back.
    await sql.begin((tx) =>
      Promise.all(
        fixes.map(
          (fix) => tx`
            UPDATE registry.apps
            SET callback_url = ${fix.callbackUrl.to},
                redirect_uris = ${tx.array(fix.redirectUris.to, 'text')},
                updated_at = now()
            WHERE id = ${fix.id}
          `,
        ),
      ),
    );
  }
  log(`\nAPPLIED — updated ${fixes.length} row(s).`);
  return fixes;
}
