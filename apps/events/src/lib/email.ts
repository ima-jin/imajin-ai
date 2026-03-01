/**
 * Email service using Proton Mail Bridge
 * 
 * Simple HTML templates - no fancy framework needed.
 */

import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '127.0.0.1',
  port: parseInt(process.env.SMTP_PORT || '1025'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'jin@imajin.ai',
    pass: process.env.SMTP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false, // Proton Bridge uses self-signed cert
  },
});

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions) {
  const from = process.env.SMTP_FROM || 'Jin <jin@imajin.ai>';
  
  try {
    const result = await transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || stripHtml(options.html),
    });
    
    console.log('Email sent:', result.messageId);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Email send failed:', error);
    return { success: false, error };
  }
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
  
  <p>We'll send you a reminder and any joining links closer to the event date.</p>
  
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
