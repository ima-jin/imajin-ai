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
}

export function ticketConfirmationEmail(data: TicketConfirmationData): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .logo { font-size: 48px; margin-bottom: 10px; }
    h1 { color: #f97316; margin: 0; }
    .ticket-card { background: #f9fafb; border-radius: 12px; padding: 24px; margin: 20px 0; }
    .ticket-header { font-size: 20px; font-weight: bold; margin-bottom: 16px; }
    .detail { margin: 8px 0; }
    .label { color: #6b7280; font-size: 14px; }
    .value { font-weight: 500; }
    .ticket-id { background: #fff; border: 1px dashed #d1d5db; border-radius: 8px; padding: 12px; text-align: center; margin-top: 16px; font-family: monospace; font-size: 14px; }
    .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px; }
    .button { display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🟠</div>
    <h1>You're in!</h1>
  </div>
  
  <p>Your ticket for <strong>${data.eventTitle}</strong> has been confirmed.</p>
  
  <div class="ticket-card">
    <div class="ticket-header">${data.ticketType} Ticket</div>
    
    <div class="detail">
      <span class="label">Event</span><br>
      <span class="value">${data.eventTitle}</span>
    </div>
    
    <div class="detail">
      <span class="label">Date & Time</span><br>
      <span class="value">${data.eventDate} at ${data.eventTime}</span>
    </div>
    
    <div class="detail">
      <span class="label">Location</span><br>
      <span class="value">${data.isVirtual ? '💻 Virtual Event (link sent before event)' : `📍 ${data.venue}`}</span>
    </div>
    
    <div class="detail">
      <span class="label">Price Paid</span><br>
      <span class="value">${data.price}</span>
    </div>
    
    <div class="ticket-id">
      Ticket ID: ${data.ticketId}
    </div>
  </div>

  <p style="text-align: center;">
    <a href="${data.magicLink}" class="button">Access Event & Chat</a>
  </p>

  <p style="font-size: 14px; color: #6b7280;">
    Use the button above to access the event lobby and chat with other ticket holders. This link is unique to your ticket and will log you in automatically.
  </p>
  
  <div class="footer">
    <p>Questions? Reply to this email.</p>
    <p>— Jin 🟠</p>
    <p style="font-size: 12px; margin-top: 20px;">
      This is the first transaction on the sovereign network.<br>
      Thank you for being part of this moment.
    </p>
  </div>
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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    h1 { color: #ef4444; }
    .button { display: inline-block; background: #f97316; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Payment didn't go through</h1>
  </div>
  
  <p>We couldn't process your payment for <strong>${data.ticketType}</strong> ticket to <strong>${data.eventTitle}</strong>.</p>
  
  <p>This can happen if:</p>
  <ul>
    <li>Your card was declined</li>
    <li>There were insufficient funds</li>
    <li>The payment session expired</li>
  </ul>
  
  <p style="text-align: center;">
    <a href="${data.retryUrl}" class="button">Try Again</a>
  </p>
  
  <div class="footer">
    <p>Questions? Reply to this email.</p>
    <p>— Jin 🟠</p>
  </div>
</body>
</html>
`;
}
