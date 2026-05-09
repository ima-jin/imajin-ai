export { sendEmail, parseSender, stripHtml, generateQRCode } from '@imajin/email';

// =============================================================================
// Email Templates (events-specific)
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
  qrCodeDataUri?: string;
  /** Multi-ticket: render a QR block per ticket. Overrides ticketId/qrCodeDataUri when present. */
  tickets?: Array<{ id: string; qrCodeDataUri?: string }>;
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

                    <!-- QR Code(s) + Ticket ID(s) -->
                    ${(data.tickets && data.tickets.length > 0 ? data.tickets : [{ id: data.ticketId, qrCodeDataUri: data.qrCodeDataUri }]).map((t, i, arr) => `
                    <div style="margin-top:${i === 0 ? '16' : '12'}px;padding:16px;background:#0a0a0a;border:1px solid #262626;border-radius:6px;text-align:center;">
                      ${arr.length > 1 ? `<div style="font-size:11px;color:#52525b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Ticket ${i + 1} of ${arr.length}</div>` : ''}
                      ${t.qrCodeDataUri ? `<img src="${t.qrCodeDataUri}" alt="Ticket QR Code" width="160" height="160" style="display:block;margin:0 auto 12px;" />` : ''}
                      <div style="font-family:'SF Mono',Monaco,Consolas,monospace;font-size:13px;color:#71717a;">
                        ${t.id}
                      </div>
                    </div>
                    `).join('')}
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

          <!-- Footer -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;text-align:center;">
              </div>
            </td>
          </tr>

          <!-- Brand -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0 0 16px;font-size:12px;color:#52525b;">The internet that pays you back</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                Part of the <a href="https://imajin.ai" style="color:#52525b;text-decoration:underline;">Imajin</a> sovereign network
                &nbsp;·&nbsp;
                <a href="https://app.dfos.com/j/c3rff6e96e4ca9hncc43en" style="color:#3f3f46;text-decoration:underline;">DFOS Community</a>
                &nbsp;·&nbsp;
                <a href="https://github.com/ima-jin/imajin-ai" style="color:#3f3f46;text-decoration:underline;">GitHub</a>
              </p>
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

interface PurchaseReceiptData {
  buyerName?: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  ticketSummary: Array<{ typeName: string; quantity: number; unitPrice: string }>;
  totalPaid: string;
  paymentMethod: string; // 'Credit Card' or 'E-Transfer'
  registrationUrl: string; // link to /[eventId]/my-tickets
  eventImageUrl?: string;
  hasRegistrationRequired?: boolean;
}

export function purchaseReceiptEmail(data: PurchaseReceiptData): string {
  const eventImage = data.eventImageUrl
    ? `<img src="${data.eventImageUrl}" alt="${data.eventTitle}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />`
    : '';

  const ticketRows = data.ticketSummary.map(t => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #262626;">
        <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${t.typeName}</span>
        <span style="font-size:13px;color:#71717a;"> × ${t.quantity}</span>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #262626;text-align:right;">
        <span style="font-size:15px;color:#e4e4e7;">${t.unitPrice}</span>
      </td>
    </tr>
  `).join('');

  const registrationCta = data.hasRegistrationRequired ? `
          <!-- Registration CTA -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1000;border-radius:8px;border:1px solid #f97316;">
                <tr>
                  <td style="padding:20px 24px;text-align:center;">
                    <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#f97316;">Action required</p>
                    <p style="margin:0 0 16px;font-size:14px;color:#a1a1aa;line-height:1.5;">One or more of your tickets require registration before they're complete.</p>
                    <a href="${data.registrationUrl}" style="display:inline-block;background-color:#f97316;color:#000000;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Register your tickets →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
  ` : '';

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
              <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Thanks for your purchase!</h1>
              <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">Here's your receipt for <strong style="color:#ffffff;">${data.eventTitle}</strong>.</p>
            </td>
          </tr>

          <!-- Receipt Card -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;">
                <tr>
                  <td style="padding:24px;">
                    <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#ffffff;">Order summary</p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Event</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventTitle}</span>
                        </td>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;"></td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Date & Time</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventDate} at ${data.eventTime}</span>
                        </td>
                      </tr>
                      ${ticketRows}
                      <tr>
                        <td style="padding:12px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:14px;color:#a1a1aa;">Payment method</span>
                        </td>
                        <td style="padding:12px 0;border-bottom:1px solid #262626;text-align:right;">
                          <span style="font-size:14px;color:#a1a1aa;">${data.paymentMethod}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:12px 0;">
                          <span style="font-size:16px;font-weight:700;color:#ffffff;">Total</span>
                        </td>
                        <td style="padding:12px 0;text-align:right;">
                          <span style="font-size:16px;font-weight:700;color:#ffffff;">${data.totalPaid}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${registrationCta}

          <!-- Footer -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;text-align:center;">
              </div>
            </td>
          </tr>

          <!-- Brand -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0 0 16px;font-size:12px;color:#52525b;">The internet that pays you back</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                Part of the <a href="https://imajin.ai" style="color:#52525b;text-decoration:underline;">Imajin</a> sovereign network
                &nbsp;·&nbsp;
                <a href="https://app.dfos.com/j/c3rff6e96e4ca9hncc43en" style="color:#3f3f46;text-decoration:underline;">DFOS Community</a>
                &nbsp;·&nbsp;
                <a href="https://github.com/ima-jin/imajin-ai" style="color:#3f3f46;text-decoration:underline;">GitHub</a>
              </p>
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

interface RegistrationReminderData {
  buyerName?: string;
  eventTitle: string;
  eventDate: string;
  pendingCount: number;
  registrationUrl: string;
  eventImageUrl?: string;
}

export function registrationReminderEmail(data: RegistrationReminderData): string {
  const eventImage = data.eventImageUrl
    ? `<img src="${data.eventImageUrl}" alt="${data.eventTitle}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />`
    : '';

  const ticketWord = data.pendingCount === 1 ? 'ticket' : 'tickets';

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
              <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Don't forget to register</h1>
              <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">You have <strong style="color:#f97316;">${data.pendingCount} ${ticketWord}</strong> waiting for registration for <strong style="color:#ffffff;">${data.eventTitle}</strong>.</p>
            </td>
          </tr>

          <!-- Info Card -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;">
                <tr>
                  <td style="padding:24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Event</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventTitle}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Date</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.eventDate}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;text-align:center;">
              <a href="${data.registrationUrl}" style="display:inline-block;background-color:#f97316;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Register now →</a>
              <p style="margin:12px 0 0;font-size:13px;color:#52525b;line-height:1.5;">Complete your registration to receive your ticket confirmation and QR code.</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;text-align:center;">
              </div>
            </td>
          </tr>

          <!-- Brand -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0 0 16px;font-size:12px;color:#52525b;">The internet that pays you back</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                Part of the <a href="https://imajin.ai" style="color:#52525b;text-decoration:underline;">Imajin</a> sovereign network
                &nbsp;·&nbsp;
                <a href="https://app.dfos.com/j/c3rff6e96e4ca9hncc43en" style="color:#3f3f46;text-decoration:underline;">DFOS Community</a>
                &nbsp;·&nbsp;
                <a href="https://github.com/ima-jin/imajin-ai" style="color:#3f3f46;text-decoration:underline;">GitHub</a>
              </p>
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

interface ETransferReservationData {
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  ticketSummary: Array<{ typeName: string; quantity: number }>;
  totalQuantity: number;
  amount: string;
  payToEmail: string;
  memo: string;
  deadline: string;
  buyerEmail: string;
  myTicketsUrl: string;
  eventImageUrl?: string;
  organizerName?: string;
}

export function etransferReservationEmail(data: ETransferReservationData): string {
  const eventImage = data.eventImageUrl
    ? `<img src="${data.eventImageUrl}" alt="${data.eventTitle}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />`
    : '';

  const summaryRows = data.ticketSummary.map(t => `
    <tr>
      <td style="padding:6px 0;">
        <span style="font-size:14px;color:#e4e4e7;">${t.quantity} × ${t.typeName}</span>
      </td>
    </tr>
  `).join('');

  const ticketWord = data.totalQuantity === 1 ? 'ticket' : 'tickets';

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

          ${eventImage ? `<tr><td style="padding:0;">${eventImage}</td></tr>` : ''}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 16px;${eventImage ? '' : 'border-radius:8px 8px 0 0;'}">
              <div style="display:inline-block;background:#f97316;color:#000;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:4px;text-transform:uppercase;margin-bottom:16px;">Reserved — Awaiting Payment</div>
              <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Your ${ticketWord} ${data.totalQuantity === 1 ? 'is' : 'are'} reserved — not yet confirmed.</h1>
              <p style="margin:0;font-size:15px;color:#a1a1aa;line-height:1.6;">${data.totalQuantity} ${ticketWord} held for <strong style="color:#ffffff;">${data.eventTitle}</strong>. Send your e-Transfer to complete the purchase.</p>
            </td>
          </tr>

          <!-- Important callout -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a1000;border:1px solid #f97316;border-radius:8px;">
                <tr>
                  <td style="padding:18px 22px;">
                    <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#f97316;">You don't have a ticket yet.</p>
                    <p style="margin:0;font-size:14px;color:#e4e4e7;line-height:1.6;">Your ${ticketWord} will be activated once we confirm your e-Transfer. We'll email <strong style="color:#ffffff;">${data.buyerEmail}</strong> with your ticket${data.totalQuantity > 1 ? 's' : ''} and QR code${data.totalQuantity > 1 ? 's' : ''} as soon as payment is received.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Payment Instructions -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;">
                <tr>
                  <td style="padding:24px;">
                    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#ffffff;">Send your Interac e-Transfer</p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Amount</span><br/>
                          <span style="font-size:18px;color:#ffffff;font-weight:700;">${data.amount}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Send to (organizer)</span><br/>
                          <span style="font-family:'SF Mono',Monaco,Consolas,monospace;font-size:14px;color:#e4e4e7;">${data.payToEmail}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid #262626;">
                          <span style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Required memo</span><br/>
                          <span style="font-family:'SF Mono',Monaco,Consolas,monospace;font-size:14px;color:#f97316;font-weight:700;">${data.memo}</span><br/>
                          <span style="font-size:12px;color:#71717a;">Paste this exactly so we can match the payment to your reservation.</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0;">
                          <span style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Pay by</span><br/>
                          <span style="font-size:14px;color:#e4e4e7;font-weight:500;">${data.deadline}</span>
                        </td>
                      </tr>
                    </table>

                    ${summaryRows ? `
                    <p style="margin:18px 0 8px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Reserved</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summaryRows}</table>
                    ` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;text-align:center;">
              <a href="${data.myTicketsUrl}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View reservation status →</a>
              <p style="margin:12px 0 0;font-size:12px;color:#52525b;line-height:1.5;">If you don't send the e-Transfer by ${data.deadline}, the hold expires and the ${ticketWord} return to inventory.</p>
            </td>
          </tr>

          <!-- Brand -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0;font-size:12px;color:#52525b;">The internet that pays you back</p>
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
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0;font-size:12px;color:#52525b;">The internet that pays you back</p>
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
