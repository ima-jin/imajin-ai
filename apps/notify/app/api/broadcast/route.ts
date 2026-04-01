import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { nanoid } from 'nanoid';
import { createHmac } from 'crypto';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { sendEmail, renderBroadcastEmail } from '@imajin/email';

// TODO(#538): These registry routes will be implemented by Agent 1.
// Stubbed here with clear fallback behavior.

const REGISTRY_URL = process.env.REGISTRY_URL;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
const UNSUBSCRIBE_HMAC_SECRET = process.env.UNSUBSCRIBE_HMAC_SECRET;

const NOTIFY_URL = process.env.NEXT_PUBLIC_NOTIFY_URL || 'https://notify.imajin.ai';

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
    console.warn('[broadcast] REGISTRY_URL not set — cannot fetch audience from registry');
    return [];
  }
  try {
    const res = await fetch(`${REGISTRY_URL}/api/audience/${encodeURIComponent(scope)}?channel=email`, {
      headers: { 'x-webhook-secret': webhookSecret },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[broadcast] Registry audience fetch failed: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.dids) ? data.dids : [];
  } catch (err) {
    console.error('[broadcast] Registry audience fetch error:', err);
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
 * Resolve a DID to a contact email via the auth service internal endpoint.
 */
async function resolveEmail(did: string, webhookSecret: string): Promise<string | null> {
  if (!AUTH_SERVICE_URL) {
    console.warn('[broadcast] AUTH_SERVICE_URL not set — cannot resolve email for', did);
    return null;
  }
  try {
    const res = await fetch(
      `${AUTH_SERVICE_URL}/api/identity/${encodeURIComponent(did)}/contact`,
      { headers: { 'x-webhook-secret': webhookSecret }, cache: 'no-store' },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.email ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  let html: string;
  let text: string | undefined = textInput;

  if (htmlInput) {
    html = htmlInput;
  } else {
    const rendered = renderBroadcastEmail(markdown!, eventContext);
    html = rendered.html;
    if (!text) text = rendered.text;
  }

  // Resolve audience
  let audienceDids: string[];
  if (explicitDids && explicitDids.length > 0) {
    audienceDids = explicitDids;
  } else {
    audienceDids = await fetchAudienceFromRegistry(scope, secret);
    if (audienceDids.length === 0) {
      return NextResponse.json(
        { sent: 0, skipped: 0, errors: 0, message: 'No audience found' },
        { headers: cors },
      );
    }
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

          const email = await resolveEmail(did, secret);
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
            }).catch((err) => console.error('[broadcast] DB insert error:', err));
          }
        } catch (err) {
          console.error(`[broadcast] Error processing DID ${did}:`, err);
          errors++;
        }
      }),
    );

    // Rate limit: pause between batches
    if (batchStart + BATCH_SIZE < audienceDids.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`[broadcast] scope=${scope} sent=${sent} skipped=${skipped} errors=${errors}`);

  return NextResponse.json({ sent, skipped, errors }, { headers: cors });
}
