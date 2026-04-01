import { marked } from 'marked';
import { emailWrapper } from './base';
import { stripHtml } from '../send';

export interface EventContext {
  title: string;
  imageUrl?: string | null;
  eventUrl?: string;
}

/**
 * Render a broadcast email from markdown source.
 * Optionally includes event context (image, title, link) matching the ticket email style.
 * Returns both HTML (wrapped in dark theme template) and plain text fallback.
 */
export function renderBroadcastEmail(
  markdown: string,
  eventContext?: EventContext,
): { html: string; text: string } {
  const bodyHtml = marked.parse(markdown) as string;

  const eventImage = eventContext?.imageUrl
    ? `
          <!-- Event Image -->
          <tr>
            <td style="padding:0;">
              <img src="${eventContext.imageUrl}" alt="${eventContext.title}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />
            </td>
          </tr>`
    : '';

  const eventHeader = eventContext
    ? `
          <!-- Event Header -->
          <tr>
            <td style="background-color:#111111;padding:24px 32px 8px;${eventContext.imageUrl ? '' : 'border-radius:8px 8px 0 0;'}">
              <p style="margin:0;font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Message from</p>
              <h1 style="margin:4px 0 0;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${eventContext.title}</h1>
            </td>
          </tr>`
    : '';

  const eventFooter = eventContext?.eventUrl
    ? `
          <!-- Event Link -->
          <tr>
            <td style="background-color:#111111;padding:16px 32px 24px;${eventContext.imageUrl ? '' : 'border-radius:0 0 8px 8px;'}text-align:center;">
              <a href="${eventContext.eventUrl}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View Event →</a>
            </td>
          </tr>`
    : '';

  const content = `
          ${eventImage}
          ${eventHeader}

          <!-- Content -->
          <tr>
            <td style="background-color:#111111;padding:${eventContext ? '16px 32px 24px' : '32px'};${eventContext ? '' : 'border-radius:8px;'}color:#ffffff;font-size:15px;line-height:1.6;">
              <div style="color:#e4e4e7;">
                ${bodyHtml}
              </div>
            </td>
          </tr>

          ${eventFooter}`;

  const html = emailWrapper(content);

  const textPrefix = eventContext ? `Message from ${eventContext.title}\n\n` : '';
  const text = textPrefix + stripHtml(bodyHtml);

  return { html, text };
}
