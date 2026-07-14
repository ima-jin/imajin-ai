import { emailWrapper, renderBroadcastEmail, stripHtml } from "@imajin/email";
import { buildPublicUrlAbsolute } from "@imajin/config";

export interface NotifyTemplate {
  scope: string;
  urgency: "low" | "normal" | "urgent";
  title: (data: Record<string, any>) => string;
  body: (data: Record<string, any>) => string;
  email?: {
    subject: (data: Record<string, any>) => string;
    html: (data: Record<string, any>) => string;
  };
}

function simpleEmailHtml(title: string, body: string): string {
  return emailWrapper(`
    <tr>
      <td style="background-color:#111111;border-radius:8px 8px 0 0;padding:32px 32px 24px;">
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${title}</h1>
        <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">${body}</p>
      </td>
    </tr>
    <tr>
      <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
        <div style="border-top:1px solid #262626;padding-top:20px;"></div>
      </td>
    </tr>
  `);
}

// =============================================================================
// Event Ticket Email Helpers
// =============================================================================

function eventImageHtml(imageUrl: string | undefined, alt: string): string {
  if (!imageUrl) return "";
  return `
          <tr>
            <td style="padding:0;">
              <img src="${imageUrl}" alt="${alt}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />
            </td>
          </tr>`;
}

function ticketConfirmedHtml(data: Record<string, any>): string {
  const eventImage = eventImageHtml(data.eventImageUrl, data.eventTitle);
  const tickets = data.tickets && data.tickets.length > 0
    ? data.tickets
    : [{ id: data.ticketId, qrCodeDataUri: data.qrCodeDataUri }];

  const qrBlocks = tickets.map((t: any, i: number, arr: any[]) => `
                    <div style="margin-top:${i === 0 ? "16" : "12"}px;padding:16px;background:#0a0a0a;border:1px solid #262626;border-radius:6px;text-align:center;">
                      ${arr.length > 1 ? `<div style="font-size:11px;color:#52525b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Ticket ${i + 1} of ${arr.length}</div>` : ""}
                      ${t.qrCodeDataUri ? `<img src="${t.qrCodeDataUri}" alt="Ticket QR Code" width="160" height="160" style="display:block;margin:0 auto 12px;" />` : ""}
                      <div style="font-family:'SF Mono',Monaco,Consolas,monospace;font-size:13px;color:#71717a;">
                        ${t.id}
                      </div>
                    </div>
  `).join("");

  return emailWrapper(`
          ${eventImage}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;${eventImage ? "" : "border-radius:8px 8px 0 0;"}">
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
                    <p style="margin:0 0 20px;font-size:18px;font-weight:600;color:#ffffff;">${data.ticketType || "Ticket"} Ticket</p>

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
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.isVirtual ? "Virtual — link sent before event" : `📍 ${data.venue}`}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Paid</span><br/>
                          <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${data.price}</span>
                        </td>
                      </tr>
                    </table>

                    ${qrBlocks}
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
  `);
}

function ticketReceiptHtml(data: Record<string, any>): string {
  const eventImage = eventImageHtml(data.eventImageUrl, data.eventTitle);
  const ticketRows = (data.ticketSummary || []).map((t: any) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #262626;">
        <span style="font-size:15px;color:#e4e4e7;font-weight:500;">${t.typeName}</span>
        <span style="font-size:13px;color:#71717a;"> × ${t.quantity}</span>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #262626;text-align:right;">
        <span style="font-size:15px;color:#e4e4e7;">${t.unitPrice}</span>
      </td>
    </tr>
  `).join("");

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
  ` : "";

  return emailWrapper(`
          ${eventImage}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;${eventImage ? "" : "border-radius:8px 8px 0 0;"}">
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
  `);
}

function ticketReservedHtml(data: Record<string, any>): string {
  const eventImage = eventImageHtml(data.eventImageUrl, data.eventTitle);
  const summaryRows = (data.ticketSummary || []).map((t: any) => `
    <tr>
      <td style="padding:6px 0;">
        <span style="font-size:14px;color:#e4e4e7;">${t.quantity} × ${t.typeName}</span>
      </td>
    </tr>
  `).join("");
  const totalQuantity = data.totalQuantity || 1;
  const ticketWord = totalQuantity === 1 ? "ticket" : "tickets";

  return emailWrapper(`
          ${eventImage}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 16px;${eventImage ? "" : "border-radius:8px 8px 0 0;"}">
              <div style="display:inline-block;background:#f97316;color:#000;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:4px;text-transform:uppercase;margin-bottom:16px;">Reserved — Awaiting Payment</div>
              <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Your ${ticketWord} ${totalQuantity === 1 ? "is" : "are"} reserved — not yet confirmed.</h1>
              <p style="margin:0;font-size:15px;color:#a1a1aa;line-height:1.6;">${totalQuantity} ${ticketWord} held for <strong style="color:#ffffff;">${data.eventTitle}</strong>. Send your e-Transfer to complete the purchase.</p>
            </td>
          </tr>

          <!-- Important callout -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a1000;border:1px solid #f97316;border-radius:8px;">
                <tr>
                  <td style="padding:18px 22px;">
                    <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#f97316;">You don't have a ticket yet.</p>
                    <p style="margin:0;font-size:14px;color:#e4e4e7;line-height:1.6;">Your ${ticketWord} will be activated once we confirm your e-Transfer. We'll email <strong style="color:#ffffff;">${data.buyerEmail}</strong> with your ticket${totalQuantity > 1 ? "s" : ""} and QR code${totalQuantity > 1 ? "s" : ""} as soon as payment is received.</p>
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
                    ` : ""}
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
  `);
}

function ticketRegistrationReminderHtml(data: Record<string, any>): string {
  const eventImage = eventImageHtml(data.eventImageUrl, data.eventTitle);
  const ticketWord = data.pendingCount === 1 ? "ticket" : "tickets";

  return emailWrapper(`
          ${eventImage}

          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;${eventImage ? "" : "border-radius:8px 8px 0 0;"}">
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
  `);
}

// =============================================================================
// Templates Array
// =============================================================================

export const templates: NotifyTemplate[] = [
  {
    scope: "market:sale",
    urgency: "normal",
    title: (_data) => "Your listing sold!",
    body: (data) => data.listingTitle ? `Your listing "${data.listingTitle}" has been sold.` : "One of your listings has been sold.",
    email: {
      subject: (_data) => "Your listing sold!",
      html: (data) => simpleEmailHtml(
        "Your listing sold!",
        data.listingTitle ? `Your listing "<strong style="color:#ffffff;">${data.listingTitle}</strong>" has been sold.` : "One of your listings has been sold."
      ),
    },
  },
  {
    scope: "market:purchase",
    urgency: "normal",
    title: (_data) => "Purchase confirmed",
    body: (data) => data.listingTitle ? `Your purchase of "${data.listingTitle}" is confirmed.` : "Your purchase has been confirmed.",
    email: {
      subject: (_data) => "Purchase confirmed",
      html: (data) => simpleEmailHtml(
        "Purchase confirmed",
        data.listingTitle ? `Your purchase of "<strong style="color:#ffffff;">${data.listingTitle}</strong>" is confirmed.` : "Your purchase has been confirmed."
      ),
    },
  },
  {
    scope: "event:ticket",
    urgency: "normal",
    title: (_data) => "Ticket confirmed",
    body: (data) => data.eventTitle ? `Your ticket for "${data.eventTitle}" is confirmed.` : "Your ticket has been confirmed.",
    email: {
      subject: (data) => data.eventTitle ? `Ticket confirmed — ${data.eventTitle}` : "Ticket confirmed",
      html: (data) => simpleEmailHtml(
        "Ticket confirmed",
        data.eventTitle ? `Your ticket for "<strong style="color:#ffffff;">${data.eventTitle}</strong>" is confirmed.` : "Your ticket has been confirmed."
      ),
    },
  },
  {
    scope: "event:registration",
    urgency: "normal",
    title: (_data) => "Registration complete",
    body: (data) => data.eventTitle ? `You're registered for "${data.eventTitle}".` : "Your registration is complete.",
    email: {
      subject: (data) => data.eventTitle ? `Registration complete — ${data.eventTitle}` : "Registration complete",
      html: (data) => simpleEmailHtml(
        "Registration complete",
        data.eventTitle ? `You're registered for "<strong style="color:#ffffff;">${data.eventTitle}</strong>".`: "Your registration is complete."
      ),
    },
  },
  {
    scope: "event:ticket-receipt",
    urgency: "normal",
    title: (data) => data.eventTitle ? `Purchase receipt — ${data.eventTitle}` : "Purchase receipt",
    body: (data) => data.eventTitle ? `Here's your receipt for "${data.eventTitle}".` : "Your purchase receipt.",
    email: {
      subject: (data) => data.eventTitle ? `Purchase receipt — ${data.eventTitle}` : "Purchase receipt",
      html: (data) => ticketReceiptHtml(data),
    },
  },
  {
    scope: "event:ticket-confirmed",
    urgency: "normal",
    title: (data) => data.eventTitle ? `You're in — ${data.eventTitle}` : "Ticket confirmed",
    body: (data) => data.eventTitle ? `Your ticket for "${data.eventTitle}" is confirmed.` : "Your ticket has been confirmed.",
    email: {
      subject: (data) => data.eventTitle ? `You're in — ${data.eventTitle}` : "Ticket confirmed",
      html: (data) => ticketConfirmedHtml(data),
    },
  },
  {
    scope: "event:ticket-reserved",
    urgency: "normal",
    title: (data) => data.eventTitle ? `Reserved — ${data.eventTitle}` : "Tickets reserved",
    body: (data) => data.eventTitle
      ? `Your tickets for "${data.eventTitle}" are reserved. Send your e-Transfer to complete the purchase.`
      : "Your tickets are reserved. Send your e-Transfer to complete the purchase.",
    email: {
      subject: (data) => data.eventTitle ? `Reserved — send your e-Transfer for ${data.eventTitle}` : "Tickets reserved",
      html: (data) => ticketReservedHtml(data),
    },
  },
  {
    scope: "event:ticket-refunded",
    urgency: "normal",
    title: (data) => data.manualRefundRequired ? `Refund pending: ${data.eventTitle || ""}` : `Refund: ${data.eventTitle || ""}`,
    body: (data) => data.refundMessage ? stripHtml(data.refundMessage).slice(0, 200) : "Your ticket has been refunded.",
    email: {
      subject: (data) => data.manualRefundRequired ? `Refund pending: ${data.eventTitle}` : `Refund: ${data.eventTitle}`,
      html: (data) => {
        const { html } = renderBroadcastEmail(data.refundMessage || "Your ticket has been refunded.", {
          title: data.eventTitle,
          imageUrl: data.eventImageUrl,
          eventUrl: data.eventUrl,
        });
        return html;
      },
    },
  },
  {
    scope: "event:ticket-registration-reminder",
    urgency: "normal",
    title: (data) => data.eventTitle ? `Don't forget to register — ${data.eventTitle}` : "Registration reminder",
    body: (data) => data.eventTitle
      ? `You have tickets waiting for registration for "${data.eventTitle}".`
      : "You have tickets waiting for registration.",
    email: {
      subject: (data) => data.eventTitle ? `Don't forget to register — ${data.eventTitle}` : "Registration reminder",
      html: (data) => ticketRegistrationReminderHtml(data),
    },
  },
  {
    scope: "coffee:tip",
    urgency: "normal",
    title: (_data) => "You received a tip!",
    body: (data) => data.amount ? `You received a tip of ${data.amount}.` : "Someone sent you a tip.",
    email: {
      subject: (_data) => "You received a tip!",
      html: (data) => simpleEmailHtml(
        "You received a tip!",
        data.amount ? `You received a tip of <strong style="color:#ffffff;">${data.amount}</strong>.` : "Someone sent you a tip."
      ),
    },
  },
  {
    scope: "coffee:tip-sent",
    urgency: "low",
    title: (_data) => "Tip sent",
    body: (data) => data.amount ? `Your tip of ${data.amount} was sent.` : "Your tip was sent.",
    email: {
      subject: (_data) => "Tip sent",
      html: (data) => simpleEmailHtml(
        "Tip sent",
        data.amount ? `Your tip of <strong style="color:#ffffff;">${data.amount}</strong> was sent.` : "Your tip was sent."
      ),
    },
  },
  {
    scope: "chat:mention",
    urgency: "normal",
    title: (data) => `${data.senderName || "Someone"} mentioned you`,
    body: (data) => data.messagePreview || "You were mentioned in a conversation.",
    email: {
      subject: (data) => `${data.senderName || "Someone"} mentioned you — Imajin Chat`,
      html: (data) => {
        const baseUrl = buildPublicUrlAbsolute('kernel');
        let chatUrl: string | null = null;
        if (data.conversationId) {
          // Parse DID: did:imajin:dm:abc123 → /chat/conversations/dm/abc123
          const prefix = 'did:imajin:';
          if (data.conversationId.startsWith(prefix)) {
            const rest = data.conversationId.slice(prefix.length);
            const colonIdx = rest.indexOf(':');
            if (colonIdx !== -1) {
              const type = rest.slice(0, colonIdx);
              const slug = rest.slice(colonIdx + 1);
              chatUrl = `${baseUrl}/chat/conversations/${type}/${slug}`;
            }
          }
        }
        const preview = data.messagePreview || "You were mentioned in a conversation.";
        const body = chatUrl
          ? `${preview}<br><br><a href="${chatUrl}" style="color:#f97316;text-decoration:none;font-weight:600;">Open conversation &rarr;</a>`
          : preview;
        return simpleEmailHtml(
          `${data.senderName || "Someone"} mentioned you`,
          body
        );
      },
    },
  },
  {
    scope: "connection:invite-accepted",
    urgency: "normal",
    title: (_data) => "Invitation accepted",
    body: (data) => data.name ? `${data.name} accepted your invitation.` : "Your invitation was accepted.",
    email: {
      subject: (_data) => "Invitation accepted",
      html: (data) => simpleEmailHtml(
        "Invitation accepted",
        data.name ? `<strong style="color:#ffffff;">${data.name}</strong> accepted your invitation.` : "Your invitation was accepted."
      ),
    },
  },
  {
    scope: 'broker:consent-request',
    urgency: 'urgent',
    title: (data) => {
      const did: string = typeof data.requesterDid === 'string' ? data.requesterDid : '';
      const short = did.length > 30 ? `${did.slice(0, 20)}\u2026${did.slice(-6)}` : did;
      return `${short || 'Someone'} requested your ${data.purpose ?? 'data'}`;
    },
    body: (data) => {
      const fields: string[] = Array.isArray(data.fields) ? data.fields : [];
      return fields.length > 0
        ? `Fields requested: ${fields.join(', ')}`
        : 'Tap to review and approve or deny.';
    },
  },
  {
    scope: 'broker:disclosure-receipt',
    urgency: 'low',
    title: (data) => {
      const did: string = typeof data.requesterDid === 'string' ? data.requesterDid : '';
      const short = did.length > 30 ? `${did.slice(0, 20)}\u2026${did.slice(-6)}` : did;
      return `${short || 'A party'} accessed your ${data.purpose ?? 'data'}`;
    },
    body: (data) => {
      const fields: string[] = Array.isArray(data.fields) ? data.fields : [];
      return fields.length > 0 ? `Fields shared: ${fields.join(', ')}` : 'Your data was disclosed.';
    },
  },
];

export function getTemplate(scope: string): NotifyTemplate | undefined {
  return templates.find((t) => t.scope === scope);
}


