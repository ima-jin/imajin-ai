import { marked, Renderer } from 'marked';
import { emailWrapper } from './base';
import { stripHtml } from '../send';

/**
 * Custom marked renderer that outputs inline-styled HTML for email clients.
 * Email clients strip <style> tags and ignore CSS classes, so every element
 * needs explicit inline styles.
 */
function createEmailRenderer(): Renderer {
  const renderer = new Renderer();

  renderer.heading = ({ text, depth }) => {
    const sizes: Record<number, string> = {
      1: 'font-size:28px;line-height:1.2;',
      2: 'font-size:22px;line-height:1.3;',
      3: 'font-size:18px;line-height:1.4;',
      4: 'font-size:16px;line-height:1.4;',
      5: 'font-size:14px;line-height:1.4;',
      6: 'font-size:13px;line-height:1.4;',
    };
    return `<h${depth} style="margin:24px 0 8px;${sizes[depth] ?? sizes[4]}font-weight:600;color:#ffffff;">${text}</h${depth}>\n`;
  };

  renderer.paragraph = ({ text }) =>
    `<p style="margin:0 0 16px;color:#e4e4e7;font-size:15px;line-height:1.6;">${text}</p>\n`;

  renderer.link = ({ href, text }) =>
    `<a href="${href}" style="color:#ffffff;text-decoration:underline;text-underline-offset:2px;" target="_blank">${text}</a>`;

  renderer.strong = ({ text }) =>
    `<strong style="color:#ffffff;font-weight:600;">${text}</strong>`;

  renderer.em = ({ text }) =>
    `<em style="color:#d4d4d8;font-style:italic;">${text}</em>`;

  renderer.list = ({ body, ordered }) => {
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag} style="margin:0 0 16px;padding-left:24px;color:#e4e4e7;">${body}</${tag}>\n`;
  };

  renderer.listitem = ({ text }) =>
    `<li style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#e4e4e7;">${text}</li>\n`;

  renderer.blockquote = ({ text }) =>
    `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #a1a1aa;background-color:#1a1a1a;color:#d4d4d8;font-size:15px;line-height:1.6;">${text}</blockquote>\n`;

  renderer.code = ({ text }) =>
    `<pre style="margin:0 0 16px;padding:16px;background-color:#1a1a1a;border-radius:6px;overflow-x:auto;"><code style="color:#e4e4e7;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;line-height:1.5;">${text}</code></pre>\n`;

  renderer.codespan = ({ text }) =>
    `<code style="background-color:#1a1a1a;color:#e4e4e7;padding:2px 6px;border-radius:3px;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;">${text}</code>`;

  renderer.hr = () =>
    `<hr style="margin:24px 0;border:none;border-top:1px solid #27272a;" />\n`;

  renderer.image = ({ href, text }) =>
    `<img src="${href}" alt="${text ?? ''}" style="max-width:100%;height:auto;border-radius:6px;margin:0 0 16px;display:block;" />\n`;

  return renderer;
}

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
  const bodyHtml = marked.parse(markdown, { breaks: true, renderer: createEmailRenderer() }) as string;

  const eventImage = eventContext?.imageUrl
    ? `
          <!-- Event Image -->
          <tr>
            <td style="padding:0;">
              <img src="${eventContext.imageUrl}" alt="${eventContext.title}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />
            </td>
          </tr>`
    : '';

  const headerBorderRadius = eventContext?.imageUrl ? '' : 'border-radius:8px 8px 0 0;';
  const eventHeader = eventContext
    ? `
          <!-- Event Header -->
          <tr>
            <td style="background-color:#111111;padding:24px 32px 8px;${headerBorderRadius}">
              <p style="margin:0;font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Message from</p>
              <h1 style="margin:4px 0 0;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${eventContext.title}</h1>
            </td>
          </tr>`
    : '';

  const footerBorderRadius = eventContext?.imageUrl ? '' : 'border-radius:0 0 8px 8px;';
  const eventFooter = eventContext?.eventUrl
    ? `
          <!-- Event Link -->
          <tr>
            <td style="background-color:#111111;padding:16px 32px 24px;${footerBorderRadius}text-align:center;">
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
