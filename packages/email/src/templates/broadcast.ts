import { Marked } from 'marked';
import { emailWrapper } from './base';
import { stripHtml } from '../send';

/**
 * Create a Marked instance with a custom renderer that outputs inline-styled
 * HTML for email clients. Email clients strip <style> tags and ignore CSS
 * classes, so every element needs explicit inline styles.
 *
 * Uses `this.parser.parseInline(tokens)` for block-level renderers so nested
 * inline formatting (bold, links, etc.) is rendered correctly (marked v18 API).
 */
function createEmailMarked(): Marked {
  const m = new Marked();

  const headingSizes: Record<number, string> = {
    1: 'font-size:28px;line-height:1.2;',
    2: 'font-size:22px;line-height:1.3;',
    3: 'font-size:18px;line-height:1.4;',
    4: 'font-size:16px;line-height:1.4;',
    5: 'font-size:14px;line-height:1.4;',
    6: 'font-size:13px;line-height:1.4;',
  };

  m.use({
    breaks: true,
    renderer: {
      // -- Block renderers (use this.parser.parseInline/parse for children) --

      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        return `<h${depth} style="margin:24px 0 8px;${headingSizes[depth] ?? headingSizes[4]}font-weight:600;color:#ffffff;">${text}</h${depth}>\n`;
      },

      paragraph({ tokens }) {
        const text = this.parser.parseInline(tokens);
        return `<p style="margin:0 0 16px;color:#e4e4e7;font-size:15px;line-height:1.6;">${text}</p>\n`;
      },

      list({ items, ordered }) {
        let body = '';
        for (const item of items) {
          body += this.listitem(item);
        }
        const tag = ordered ? 'ol' : 'ul';
        return `<${tag} style="margin:0 0 16px;padding-left:24px;color:#e4e4e7;">${body}</${tag}>\n`;
      },

      listitem(item) {
        const text = this.parser.parse(item.tokens);
        return `<li style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#e4e4e7;">${text}</li>\n`;
      },

      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        return `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #a1a1aa;background-color:#1a1a1a;color:#d4d4d8;font-size:15px;line-height:1.6;">${body}</blockquote>\n`;
      },

      code({ text }) {
        return `<pre style="margin:0 0 16px;padding:16px;background-color:#1a1a1a;border-radius:6px;overflow-x:auto;"><code style="color:#e4e4e7;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;line-height:1.5;">${text}</code></pre>\n`;
      },

      hr() {
        return `<hr style="margin:24px 0;border:none;border-top:1px solid #27272a;" />\n`;
      },

      // -- Inline renderers (use this.parser.parseInline for nested content) --

      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        return `<a href="${href}" style="color:#ffffff;text-decoration:underline;text-underline-offset:2px;" target="_blank">${text}</a>`;
      },

      strong({ tokens }) {
        const text = this.parser.parseInline(tokens);
        return `<strong style="color:#ffffff;font-weight:600;">${text}</strong>`;
      },

      em({ tokens }) {
        const text = this.parser.parseInline(tokens);
        return `<em style="color:#d4d4d8;font-style:italic;">${text}</em>`;
      },

      codespan({ text }) {
        return `<code style="background-color:#1a1a1a;color:#e4e4e7;padding:2px 6px;border-radius:3px;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;">${text}</code>`;
      },

      image({ href, text }) {
        return `<img src="${href}" alt="${text ?? ''}" style="max-width:100%;height:auto;border-radius:6px;margin:0 0 16px;display:block;" />\n`;
      },
    },
  });

  return m;
}

/** Singleton Marked instance for broadcast emails */
const emailMarked = createEmailMarked();

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
  const bodyHtml = emailMarked.parse(markdown) as string;

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
