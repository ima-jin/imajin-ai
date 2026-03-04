/**
 * Email service using SendGrid API
 * 
 * Simple HTML templates - no fancy framework needed.
 * 
 * Required env vars:
 *   SENDGRID_API_KEY - API key (starts with SG.)
 *   SENDGRID_FROM    - Verified sender (e.g. "Jin <jin@imajin.ai>")
 */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || 'Jin <jin@imajin.ai>';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions) {
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
      return { success: true, messageId: res.headers.get('x-message-id') };
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

function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// =============================================================================
// Email Templates
// =============================================================================

interface TicketConfirmationData {
  eventTitle: string;
  ticketType: string;
  ticketId: string;
  eventDate: string;
  eventTime: string;
  isVirtual: boolean;
  venue?: string;
  price: string;
  magicLink: string;
  eventImageUrl?: string;
  eventUrl?: string;
}

export function ticketConfirmationEmail(data: TicketConfirmationData): string {
  const eventImage = data.eventImageUrl
    ? `<img src="${data.eventImageUrl}" alt="${data.eventTitle}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />`
    : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;">
    <tr>
      <td align="center" style="padding:20px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Event Image -->
          ${eventImage ? `
          <tr>
            <td style="padding:0;">
              ${eventImage}
            </td>
          </tr>
          ` : ''}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;${eventImage ? '' : 'border-radius:8px 8px 0 0;'}">
              <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">You're in.</h1>
              <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">Your ticket for <strong style="color:#ffffff;">${data.eventTitle}</strong> is confirmed.</p>
            </td>
          </tr>

          <!-- Ticket Card -->
          <tr>
            <td style="background-color:#111111;padding:0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;">
                <tr>
                  <td style="padding:24px;">
                    <p style="margin:0 0 20px;font-size:18px;font-weight:600;color:#ffffff;">${data.ticketType} Ticket</p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Event</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventTitle}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Date & Time</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventDate} at ${data.eventTime}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Location</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.isVirtual ? 'Virtual — link sent before event' : `📍 ${data.venue}`}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Paid</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.price}</span>
                        </td>
                      </tr>
                    </table>

                    <!-- Ticket ID -->
                    <div style="margin-top:16px;padding:10px;background:#0a0a0a;border:1px dashed #333;border-radius:6px;text-align:center;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:13px;color:#71717a;">
                      ${data.ticketId}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="background-color:#111111;padding:24px 32px;text-align:center;">
              <a href="${data.magicLink}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Access Event & Chat →</a>
              <p style="margin:12px 0 0;font-size:13px;color:#52525b;line-height:1.5;">This link is unique to your ticket and logs you in automatically.</p>
            </td>
          </tr>

          <!-- Sovereign message -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;text-align:center;">
                <p style="margin:0 0 4px;font-size:13px;color:#52525b;">You just transacted on the sovereign network.</p>
                <p style="margin:0;font-size:13px;color:#3f3f46;">No platform. No middleman. Yours.</p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:1px;">IMAJIN</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">今人 — The internet that pays you back</p>
              ${data.eventUrl ? `<p style="margin:8px 0 0;"><a href="${data.eventUrl}" style="font-size:12px;color:#52525b;text-decoration:underline;">View event</a></p>` : ''}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

interface PaymentFailedData {
  eventTitle: string;
  ticketType: string;
  retryUrl: string;
}

export function paymentFailedEmail(data: PaymentFailedData): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;">
    <tr>
      <td align="center" style="padding:20px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="background-color:#111111;border-radius:8px;padding:32px;">
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#ef4444;">Payment didn't go through</h1>
              <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">We couldn't process your payment for <strong style="color:#ffffff;">${data.ticketType}</strong> ticket to <strong style="color:#ffffff;">${data.eventTitle}</strong>.</p>
              <p style="margin:0 0 8px;font-size:14px;color:#71717a;">This can happen if:</p>
              <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#a1a1aa;line-height:1.8;">
                <li>Your card was declined</li>
                <li>There were insufficient funds</li>
                <li>The payment session expired</li>
              </ul>
              <div style="text-align:center;">
                <a href="${data.retryUrl}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Try Again →</a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:1px;">IMAJIN</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">今人 — The internet that pays you back</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
