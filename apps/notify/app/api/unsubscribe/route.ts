import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

const REGISTRY_URL = process.env.REGISTRY_URL;
const UNSUBSCRIBE_HMAC_SECRET = process.env.UNSUBSCRIBE_HMAC_SECRET;

/**
 * Verify the unsubscribe token: HMAC-SHA256(secret, did:scope)
 */
function verifyToken(did: string, scope: string, token: string): boolean {
  if (!UNSUBSCRIBE_HMAC_SECRET) return false;
  const expected = createHmac('sha256', UNSUBSCRIBE_HMAC_SECRET)
    .update(`${did}:${scope}`)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Update registry preference to opt-out of marketing for this scope.
 * TODO(#538): Registry PUT /api/preferences/:did/interests/:scope implemented by Agent 1.
 */
async function updateRegistryPreference(did: string, scope: string): Promise<void> {
  if (!REGISTRY_URL) {
    console.warn('[unsubscribe] REGISTRY_URL not set — cannot update registry preference');
    return;
  }
  try {
    const webhookSecret = process.env.NOTIFY_WEBHOOK_SECRET;
    const res = await fetch(
      `${REGISTRY_URL}/api/preferences/${encodeURIComponent(did)}/interests/${encodeURIComponent(scope)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-webhook-secret': webhookSecret } : {}),
        },
        body: JSON.stringify({ marketing: false, email: false }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[unsubscribe] Registry update failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error('[unsubscribe] Registry update error:', err);
  }
}

function renderPage(title: string, message: string, detail?: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Imajin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: #111827;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      padding: 48px 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 15px; color: #6b7280; line-height: 1.6; }
    .detail { margin-top: 8px; font-size: 13px; color: #9ca3af; }
    a { color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${detail ? `<p class="detail">${detail}</p>` : ''}
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function renderErrorPage(message: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Error — Imajin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: #111827;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      padding: 48px 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 15px; color: #6b7280; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠</div>
    <h1>Invalid Link</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * GET /api/unsubscribe?did=X&scope=Y&token=Z
 *
 * Renders a confirmation page and processes the unsubscribe immediately.
 * Token is HMAC-SHA256(UNSUBSCRIBE_HMAC_SECRET, did:scope) — no DB lookup required.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did');
  const scope = searchParams.get('scope');
  const token = searchParams.get('token');

  if (!did || !scope || !token) {
    return renderErrorPage('Missing required parameters. This link may be incomplete.');
  }

  if (!verifyToken(did, scope, token)) {
    return renderErrorPage('This unsubscribe link is invalid or has expired.');
  }

  // Process unsubscribe
  await updateRegistryPreference(did, scope);

  const scopeLabel = scope.charAt(0).toUpperCase() + scope.slice(1);
  return renderPage(
    "You've been unsubscribed",
    `You'll no longer receive ${scopeLabel} marketing emails.`,
    'You can manage your notification preferences at any time from your account settings.',
  );
}

/**
 * POST /api/unsubscribe
 *
 * One-click List-Unsubscribe handler per RFC 8058.
 * Email clients send: List-Unsubscribe=One-Click in body (application/x-www-form-urlencoded)
 * along with did, scope, token query params from the List-Unsubscribe header URL.
 *
 * Returns 200 on success — email clients expect a fast, simple response.
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const did = searchParams.get('did');
  const scope = searchParams.get('scope');
  const token = searchParams.get('token');

  if (!did || !scope || !token) {
    return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
  }

  if (!verifyToken(did, scope, token)) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
  }

  await updateRegistryPreference(did, scope);

  return NextResponse.json({ ok: true });
}
