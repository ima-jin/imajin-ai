import { marked } from 'marked';
import { emailWrapper } from './base';
import { stripHtml } from '../send';

/**
 * Render a broadcast email from markdown source.
 * Returns both HTML (wrapped in dark theme template) and plain text fallback.
 */
export function renderBroadcastEmail(markdown: string): { html: string; text: string } {
  const bodyHtml = marked.parse(markdown) as string;

  const content = `
          <!-- Content -->
          <tr>
            <td style="background-color:#111111;padding:32px;border-radius:8px;color:#ffffff;font-size:15px;line-height:1.6;">
              <div style="color:#e4e4e7;">
                ${bodyHtml}
              </div>
            </td>
          </tr>`;

  const html = emailWrapper(content);
  const text = stripHtml(bodyHtml);

  return { html, text };
}
