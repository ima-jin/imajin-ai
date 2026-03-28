import { emailWrapper } from '@imajin/email';

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
        data.eventTitle ? `You're registered for "<strong style="color:#ffffff;">${data.eventTitle}</strong>".` : "Your registration is complete."
      ),
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
];

export function getTemplate(scope: string): NotifyTemplate | undefined {
  return templates.find((t) => t.scope === scope);
}
