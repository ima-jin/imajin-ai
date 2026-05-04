import { createLogger } from '@imajin/logger';
import { getProvider } from './providers';
import type { SendEmailOptions } from './types';

const log = createLogger('email');

// CAN-SPAM required physical address
const PHYSICAL_ADDRESS = 'Imajin Inc., 118 Sheridan Ave, Toronto, ON, Canada';

export type { SendEmailOptions } from './types';

export async function sendEmail(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
  const provider = getProvider();

  // Append unsubscribe footer to HTML when an unsubscribe URL is provided
  const htmlBody = options.unsubscribeUrl
    ? appendUnsubscribeFooter(options.html, options.unsubscribeUrl)
    : options.html;

  const textBody = options.text
    ? (options.unsubscribeUrl ? `${options.text}\n\n---\nTo unsubscribe: ${options.unsubscribeUrl}\n${PHYSICAL_ADDRESS}` : options.text)
    : stripHtml(htmlBody);

  return provider.send({
    ...options,
    html: htmlBody,
    text: textBody,
  });
}

function appendUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const footer = `
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;font-family:sans-serif;">
  <p style="margin:0 0 4px;">Don't want these emails? <a href="${unsubscribeUrl}" style="color:#6b7280;">Unsubscribe</a></p>
  <p style="margin:0;">${PHYSICAL_ADDRESS}</p>
</div>`;

  // Insert before closing </body> if present, otherwise append
  if (html.includes('</body>')) {
    return html.replace('</body>', `${footer}</body>`);
  }
  return html + footer;
}

// Re-export parseSender from types for backward compatibility
export { parseSender } from './types';

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
