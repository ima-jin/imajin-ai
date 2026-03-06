const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || 'Jin <jin@imajin.ai>';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<{ success: boolean; error?: any; messageId?: string }> {
  if (!SENDGRID_API_KEY) {
    console.warn('SENDGRID_API_KEY not set — skipping email to', options.to);
    return { success: false, error: 'No API key configured' };
  }

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
        subject: options.subject,
        content: [
          { type: 'text/plain', value: options.text || stripHtml(options.html) },
          { type: 'text/html', value: options.html },
        ],
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

export function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from };
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
