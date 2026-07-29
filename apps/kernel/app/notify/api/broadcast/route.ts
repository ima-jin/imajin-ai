import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions, buildPublicUrlAbsolute } from '@imajin/config';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
import { createHmac } from 'node:crypto';
import { db, notifications, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { sendEmail, renderBroadcastEmail } from '@imajin/email';

// TODO(#538): These registry routes will be implemented by Agent 1.
// Stubbed here with clear fallback behavior.

const REGISTRY_URL = process.env.REGISTRY_URL;
const UNSUBSCRIBE_HMAC_SECRET = process.env.UNSUBSCRIBE_HMAC_SECRET;

const NOTIFY_URL = buildPublicUrlAbsolute('notify');

/** Max recipients per batch to avoid SendGrid rate limits */
const BATCH_SIZE = 100;
/** Delay between batches in milliseconds */
const BATCH_DELAY_MS = 1000;

function makeUnsubscribeToken(did: string, scope: string): string | null {
  if (!UNSUBSCRIBE_HMAC_SECRET) return null;
  return createHmac('sha256', UNSUBSCRIBE_HMAC_SECRET)
    .update(`${did}:${scope}`)
    .digest('hex');
}

function makeUnsubscribeUrl(did: string, scope: string): string | null {
  const token = makeUnsubscribeToken(did, scope);
  if (!token) return null;
  return `${NOTIFY_URL}/api/unsubscribe?did=${encodeURIComponent(did)}&scope=${encodeURIComponent(scope)}&token=${token}`;
}

/**
 * Fetch audience DIDs from registry for a scope.
 * TODO(#538): Registry /api/audience/:scope implemented by Agent 1.
 */
async function fetchAudienceFromRegistry(
  scope: string,
  webhookSecret: string,
): Promise<string[]> {
  if (!REGISTRY_URL) {
    log.warn({}, 'REGISTRY_URL not set — cannot fetch audience from registry');
    return [];
  }
  try {
    const res = await fetch(`${REGISTRY_URL}/api/audience/${encodeURIComponent(scope)}?channel=email`, {
      headers: { 'x-webhook-secret': webhookSecret },
      cache: 'no-store',
    });
    if (!res.ok) {
      log.error({ status: res.status }, 'Registry audience fetch failed');
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.dids) ? data.dids : [];
  } catch (err) {
    log.error({ err: String(err) }, 'Registry audience fetch error');
    return [];
  }
}

/**
 * Check registry preferences for a DID + scope.
 * Returns true if the DID is eligible to receive marketing email for this scope.
 * TODO(#538): Registry /api/preferences/:did implemented by Agent 1.
 */
async function checkRegistryPreferences(
  did: string,
  scope: string,
  webhookSecret: string,
): Promise<boolean> {
  if (!REGISTRY_URL) return true; // optimistic if registry not configured
  try {
    const res = await fetch(
      `${REGISTRY_URL}/api/preferences/${encodeURIComponent(did)}`,
      { headers: { 'x-webhook-secret': webhookSecret }, cache: 'no-store' },
    );
    if (!res.ok) return true; // default to eligible on registry error
    const prefs = await res.json();

    // Global marketing kill-switch
    if (prefs.globalMarketing === false) return false;

    // Per-scope interest check (if the row exists)
    const scopePrefs = (prefs.interests ?? []).find(
      (i: { scope: string }) => i.scope === scope,
    );
    if (scopePrefs) {
      if (scopePrefs.marketing === false) return false;
      if (scopePrefs.email === false) return false;
    }

    return true;
  } catch {
    return true; // optimistic on error
  }
}

/**
 * Resolve a DID to a contact email via direct DB query.
 */
async function resolveEmail(did: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ contactEmail: identities.contactEmail })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);
    return row?.contactEmail ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the HTML/text content for a broadcast email.
 * If `htmlInput` is provided it is used directly; otherwise the markdown
 * is rendered via `renderBroadcastEmail`.
 *
 * Cognitive complexity: 1 (≤ 15)
 */
function resolveEmailContent(
  htmlInput: string | undefined,
  markdown: string | undefined,
  textInput: string | undefined,
  eventContext: { title: string; imageUrl?: string | null; eventUrl?: string } | undefined,
): { html: string; text: string | undefined } {
  if (htmlInput) return { html: htmlInput, text: textInput };
  const rendered = renderBroadcastEmail(markdown!, eventContext);
  return { html: rendered.html, text: textInput ?? rendered.text };
}

/**
 * Resolve the audience DIDs for a broadcast.
 * Uses `explicitDids` if provided; otherwise fetches from the registry.
 * Returns null when no audience is found (caller should short-circuit).
 *
 * Cognitive complexity: 3 (≤ 15)
 */
async function resolveAudienceDids(
  scope: string,
  explicitDids: string[] | undefined,
  secret: string,
): Promise<string[] | null> {
  if (explicitDids && explicitDids.length > 0) return explicitDids;
  const dids = await fetchAudienceFromRegistry(scope, secret);
  if (dids.length === 0) return null;
  return dids;
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/broadcast
 *
 * Bulk-send a marketing email to an audience.
 *
 * Body:
 *   scope       — interest scope ('events', 'market', 'coffee', ...)
 *   dids?       — explicit list; if omitted, fetched from registry /api/audience/:scope
 *   subject     — email subject
 *   html        — email HTML body
 *   text?       — plain text fallback
 *   channels?   — default ['email']
 *
 * Auth: x-webhook-secret header (kernel services only)
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: {
    scope: string;
    dids?: string[];
    subject: string;
    html?: string;
    markdown?: string;
    text?: string;
    channels?: ('email' | 'inapp' | 'chat')[];
    eventContext?: { title: string; imageUrl?: string | null; eventUrl?: string };
    replyTo?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { scope, dids: explicitDids, subject, html: htmlInput, markdown, text: textInput, channels = ['email'], eventContext, replyTo } = body;

  if (!scope || !subject || (!htmlInput && !markdown)) {
    return NextResponse.json(
      { error: 'Missing required fields: scope, subject, html (or markdown)' },
      { status: 400, headers: cors },
    );
  }

  const { html, text } = resolveEmailContent(htmlInput, markdown, textInput, eventContext);

  // Resolve audience
  const audienceDids = await resolveAudienceDids(scope, explicitDids, secret);
  if (!audienceDids) {
    return NextResponse.json(
      { sent: 0, skipped: 0, errors: 0, message: 'No audience found' },
      { headers: cors },
    );
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches
  for (let batchStart = 0; batchStart < audienceDids.length; batchStart += BATCH_SIZE) {
    const batch = audienceDids.slice(batchStart, batchStart + BATCH_SIZE);

    await Promise.all(
      batch.map(async (did) => {
        try {
          // Check registry preferences (if we fetched audience ourselves, prefs are already
          // baked in; if explicit dids, we still check per-DID)
          const eligible = await checkRegistryPreferences(did, scope, secret);
          if (!eligible) {
            skipped++;
            return;
          }

          const email = await resolveEmail(did);
          if (!email) {
            skipped++;
            return;
          }

          const unsubscribeUrl = makeUnsubscribeUrl(did, scope);
          const channelsSent: string[] = [];

          if (channels.includes('email')) {
            const result = await sendEmail({
              to: email,
              subject,
              html,
              text,
              ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
              ...(replyTo ? { replyTo } : {}),
            });

            if (result.success) {
              channelsSent.push('email');
              sent++;
            } else {
              errors++;
            }
          }

          // Log to notifications table
          if (channelsSent.length > 0) {
            await db.insert(notifications).values({
              id: `ntf_${nanoid(16)}`,
              recipientDid: did,
              scope,
              urgency: 'low',
              title: subject,
              body: undefined,
              data: { broadcast: true, channels },
              channelsSent,
              read: false,
            }).catch((err) => log.error({ err: String(err) }, 'DB insert error'));
          }
        } catch (err) {
          log.error({ err: String(err), did }, 'Error processing DID');
          errors++;
        }
      }),
    );

    // Rate limit: pause between batches
    if (batchStart + BATCH_SIZE < audienceDids.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  log.info({ scope, sent, skipped, errors }, 'broadcast complete');

  return NextResponse.json({ sent, skipped, errors }, { headers: cors });
}
