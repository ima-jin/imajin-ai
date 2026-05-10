# Audit: Events Service `sendEmail` Call Sites (#889)

## Overview

Seven `sendEmail()` call sites in `apps/events/` bypass the bus → notify reactor → kernel pipeline. Each already publishes a bus event for attestations/MJN in some cases, but the buyer-facing email was left as a direct send when the notify reactor was wired.

Decision (Ryan, confirmed): **separate event types**, not piggyback on existing `ticket.purchased`.

---

## Call Site 1: `apps/events/src/lib/confirm-payment.ts`

**Lines:** ~200 (receipt), ~230 (ticket confirmation)

**What it sends today:**
1. `purchaseReceiptEmail` — order summary, payment method "E-Transfer", registration CTA if required
2. `ticketConfirmationEmail` — rich ticket card with QR code(s), event image, magic link

**Data needed:**
- buyer email, name (from auth.identities or orders.buyer_email)
- event title, date, time, image URL, venue, isVirtual
- ticket summary (type name × qty × unit price), total formatted
- payment method, registration URL, hasRegistrationRequired
- QR code data URIs (pre-generated in events service, passed in payload)
- magic link (onboard token)

**Existing bus event?** YES — `ticket.purchased` is published once per confirmed ticket (attestation + MJN). **Do NOT remove or alter** — it serves the attestation/MJN chain.

**New event types:**
- `ticket.receipt` → scope `event:ticket-receipt` (purchase receipt)
- `ticket.confirmed` → scope `event:ticket-confirmed` (ticket bundle with QR)

**Notes:**
- QR codes generated via `generateQRCode(t.id)` in events service, passed as `tickets: [{id, qrCodeDataUri}]` in payload.
- Two separate publishes because notify reactor sends one notification per event.

---

## Call Site 2: `apps/events/app/api/register/[ticketId]/route.ts`

**Line:** ~176

**What it sends today:**
- `ticketConfirmationEmail` — same rich ticket card with QR code

**Data needed:**
- registration email
- event title, date, time, image URL, venue, isVirtual
- ticket type name, ticket ID
- price formatted
- QR code data URI (pre-generated)
- magic link (event URL)

**Existing bus event?** YES — `event.registration` and `event.rsvp` are already published for the same action. **Do NOT remove.**

**New event type:**
- `ticket.registration.completed` → scope `event:ticket-confirmed` (reuses the same template as `ticket.confirmed` since content is identical)

**Notes:**
- QR generation must happen before the response is returned (currently inside the `sendEmail` try-block; needs to be hoisted).

---

## Call Site 3: `apps/events/app/api/checkout/free/route.ts`

**Line:** ~314

**What it sends today:**
- `ticketConfirmationEmail` — rich ticket card with QR code for free RSVP

**Data needed:**
- owner email
- event title, date, time, image URL, venue, isVirtual
- ticket type name, ticket ID
- price = "Free"
- QR code data URI
- magic link (onboard token)

**Existing bus event?** YES — `ticket.purchased` is published (attestation + MJN + basic notify). **Do NOT remove.**

**New event type:**
- `ticket.confirmed` → scope `event:ticket-confirmed`

**Notes:**
- Onboard token creation stays in events service; magic link passed in payload.

---

## Call Site 4: `apps/events/app/api/checkout/etransfer/route.ts`

**Line:** ~408

**What it sends today:**
- `etransferReservationEmail` — "Reserved — Awaiting Payment" with Interac instructions, memo, deadline, ticket summary

**Data needed:**
- buyer email
- event title, date, time, image URL
- ticket summary (type name × qty)
- total quantity, formatted amount, currency
- organizer pay-to email, memo, formatted deadline
- my-tickets URL

**Existing bus event?** NO — this route does not publish any bus event today.

**New event type:**
- `ticket.reserved` → scope `event:ticket-reserved`

**Notes:**
- No QR codes needed (ticket is not yet confirmed).

---

## Call Site 5: `apps/events/app/api/events/[id]/tickets/[ticketId]/refund/route.ts`

**Line:** ~170

**What it sends today:**
- `renderBroadcastEmail` with a markdown refund message — different copy for Stripe (auto-refunded), EMT (manual pending), and free tickets

**Data needed:**
- customer email (resolved from registration → profile → auth credential)
- event title, image URL
- refund message (markdown)
- manualRefundRequired flag (for subject line)

**Existing bus event?** NO.

**New event type:**
- `ticket.refunded` → scope `event:ticket-refunded`

**Notes:**
- Kernel template can reuse `@imajin/email`'s `renderBroadcastEmail` to render the markdown payload.
- This route currently imports `sendEmail` and `renderBroadcastEmail` directly from `@imajin/email` (not `@/src/lib/email`).

---

## Call Site 6: `apps/events/app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts`

**Lines:** ~156 (registration reminder), ~177 (ticket confirmation)

**What it sends today:**
- If `registrationStatus === 'pending'`: `registrationReminderEmail` — "Don't forget to register" with CTA
- Else: `ticketConfirmationEmail` — rich ticket card with QR code

**Data needed (reminder):**
- customer email
- event title, date, image URL
- pending count, registration URL (magic link)

**Data needed (confirmation):**
- customer email
- event title, date, time, image URL, venue, isVirtual
- ticket type, ticket ID
- formatted price
- QR code data URI
- magic link

**Existing bus event?** NO.

**New event types:**
- `ticket.registration.reminder` → scope `event:ticket-registration-reminder` (pending case)
- `ticket.confirmed` → scope `event:ticket-confirmed` (complete case)

**Notes:**
- Route has a 3-day cooldown check and `lastEmailSentAt` update — **keep**.
- After refactor, publish is fire-and-forget; update `lastEmailSentAt` unconditionally (same as other routes where email failure was non-fatal).

---

## Call Site 7: `apps/events/app/api/webhook/payment/route.ts`

**Lines:** ~485 (receipt), ~516 (ticket confirmation)

**What it sends today:**
1. `purchaseReceiptEmail` — order summary, payment method "Credit Card" or "E-Transfer", registration CTA
2. `ticketConfirmationEmail` — rich ticket card with QR code(s)

**Data needed:**
- customer email, name
- event title, date, time, image URL, venue, isVirtual
- ticket type name, quantity, unit price, total formatted
- payment method, registration URL, hasRegistrationRequired
- QR code data URIs
- magic link

**Existing bus event?** YES — `ticket.purchased` (per ticket) and `order.completed` are already published. **Do NOT remove or alter.**

**New event types:**
- `ticket.receipt` → scope `event:ticket-receipt`
- `ticket.confirmed` → scope `event:ticket-confirmed`

**Notes:**
- ⚠️ **This is the prod payment path.** Stripe webhook must remain idempotent and must not throw.
- Both publishes are fire-and-forget (`.catch()`), same as current `sendEmail` pattern.

---

## Scope → Template Mapping

| Scope | Event Type(s) | Purpose |
|-------|---------------|---------|
| `event:ticket-receipt` | `ticket.receipt` | Purchase receipt with order summary |
| `event:ticket-confirmed` | `ticket.confirmed`, `ticket.registration.completed` | Ticket bundle with QR code(s) |
| `event:ticket-reserved` | `ticket.reserved` | EMT reservation instructions |
| `event:ticket-refunded` | `ticket.refunded` | Refund notification (markdown via broadcast renderer) |
| `event:ticket-registration-reminder` | `ticket.registration.reminder` | "Don't forget to register" reminder |

## QR Code Strategy

Kernel templates are sync; `generateQRCode` is async. **Pre-render QR data URIs in events service and pass them in payload.** This is option (b) from the issue — chosen because option (a) would require async template rendering in kernel, which is a larger refactor.

## Files to Modify

### Kernel
- `apps/kernel/src/lib/notify/templates.ts` — add 5 new template scopes

### Bus
- `packages/bus/src/config.ts` — register 6 new event types with notify reactors
- `packages/bus/src/types.ts` — add payload types to `BusEventMap`

### Events (call sites)
- `apps/events/src/lib/confirm-payment.ts`
- `apps/events/app/api/register/[ticketId]/route.ts`
- `apps/events/app/api/checkout/free/route.ts`
- `apps/events/app/api/checkout/etransfer/route.ts`
- `apps/events/app/api/events/[id]/tickets/[ticketId]/refund/route.ts`
- `apps/events/app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts`
- `apps/events/app/api/webhook/payment/route.ts`

### Events (cleanup)
- `apps/events/src/lib/email.ts` — remove `sendEmail`, `parseSender`, `stripHtml` exports (keep `generateQRCode`)
- `apps/events/.env.example` — remove SMTP_*/SENDGRID_* vars
