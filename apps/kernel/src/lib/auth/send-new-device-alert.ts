import { db, credentials } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface NewDeviceAlertParams {
  did: string;
  platform: string;
  browser: string;
  city?: string | null;
  country?: string | null;
}

/**
 * "{city}, {country}" / "{country}" / null when neither is known (#306 —
 * no geo-IP source exists in this repo, so this is always null today).
 */
function formatLocation(city?: string | null, country?: string | null): string | null {
  if (city && country) return `${city}, ${country}`;
  return country ?? null;
}

function renderDetailLines(platform: string, browser: string, location: string | null, timestamp: string): string {
  const locationLine = location ? `${location} · ${timestamp}` : timestamp;
  return `
          <tr>
            <td style="background-color:#111111;padding:32px 32px 16px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#ffffff;">New login to your account</h1>
              <p style="margin:0 0 4px;font-size:16px;color:#ffffff;"><strong>${browser}</strong> on <strong>${platform}</strong></p>
              <p style="margin:0;font-size:14px;color:#a1a1aa;">${locationLine}</p>
            </td>
          </tr>`;
}

function renderHtml(params: { platform: string; browser: string; location: string | null; timestamp: string; rotationLink: string }): string {
  return `${renderDetailLines(params.platform, params.browser, params.location, params.timestamp)}
          <tr>
            <td style="background-color:#111111;padding:8px 32px 24px;">
              <p style="margin:0 0 16px;font-size:14px;color:#a1a1aa;line-height:1.6;">If this was you, no action is needed.</p>
              <a href="${params.rotationLink}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Not you? Secure your account →</a>
            </td>
          </tr>
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;"></td>
          </tr>`;
}

function renderText(params: { platform: string; browser: string; location: string | null; timestamp: string; rotationLink: string }): string {
  const locationLine = params.location ? `${params.location} · ${params.timestamp}` : params.timestamp;
  return [
    'We noticed a new login to your account:',
    '',
    `${params.browser} on ${params.platform}`,
    locationLine,
    '',
    'If this was you, no action needed.',
    `If not, secure your account: ${params.rotationLink}`,
  ].join('\n');
}

/**
 * Email the user when a new (unrecognized) device logs in (#306). No-op if
 * the DID has no email credential on file. Non-fatal — a failed send must
 * never block or fail the login itself; callers should `.catch()` this.
 */
export async function sendNewDeviceAlert(params: NewDeviceAlertParams): Promise<void> {
  const emailCreds = await db
    .select({ value: credentials.value })
    .from(credentials)
    .where(and(eq(credentials.did, params.did), eq(credentials.type, 'email')))
    .limit(1);

  if (emailCreds.length === 0) return;

  const rotationLink = `${buildPublicUrlAbsolute('profile')}/keys`;
  const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const location = formatLocation(params.city, params.country);
  const templateParams = { platform: params.platform, browser: params.browser, location, timestamp, rotationLink };

  try {
    const { sendEmail, emailWrapper } = await import('@imajin/email');
    await sendEmail({
      to: emailCreds[0].value,
      subject: 'New login to your Imajin account',
      html: emailWrapper(renderHtml(templateParams)),
      text: renderText(templateParams),
    });
  } catch (err) {
    log.error({ err: String(err) }, '[new-device-alert] send failed (non-fatal)');
  }
}
