const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || 'Jin <jin@imajin.ai>';

// CAN-SPAM required physical address
const PHYSICAL_ADDRESS = 'Imajin Inc., Bracebridge, ON, Canada';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** When set, adds List-Unsubscribe / List-Unsubscribe-Post headers and a footer link */
  unsubscribeUrl?: string;
  /** Reply-To address (e.g. event organizer email) */
  replyTo?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
  if (!SENDGRID_API_KEY) {
    console.warn('SENDGRID_API_KEY not set — skipping email to', options.to);
    return { success: false, error: 'No API key configured' };
  }

  const headers: Record<string, string> = {};
  if (options.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${options.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  // Append unsubscribe footer to HTML when an unsubscribe URL is provided
  const htmlBody = options.unsubscribeUrl
    ? appendUnsubscribeFooter(options.html, options.unsubscribeUrl)
    : options.html;

  const textBody = options.text
    ? (options.unsubscribeUrl ? `${options.text}\n\n---\nTo unsubscribe: ${options.unsubscribeUrl}\n${PHYSICAL_ADDRESS}` : options.text)
    : stripHtml(htmlBody);

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: options.to }] }],
        from: parseSender(SENDGRID_FROM),
        ...(options.replyTo && { reply_to: { email: options.replyTo } }),
        subject: options.subject,
        content: [
          { type: 'text/plain', value: textBody },
          { type: 'text/html', value: htmlBody },
        ],
        ...(Object.keys(headers).length > 0 && { headers }),
      }),
    });

    if (res.status === 202) {
      console.log('Email sent via SendGrid to', options.to);
      return { success: true, messageId: res.headers.get('x-message-id') ?? undefined };
    } else {
      const body = await res.text();
      console.error('SendGrid error:', res.status, body);
      return { success: false, error: `SendGrid ${res.status}: ${body}` };
    }
  } catch (error) {
    console.error('Email send failed:', error);
    return { success: false, error };
  }
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

export function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from };
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
