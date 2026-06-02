/**
 * Resolve attendee name/email with full fallback chain, and detect guest-of.
 *
 * Name precedence (first non-empty wins):
 *   1. Survey response (full_name or name)
 *   2. Profile-service lookup name
 *   3. auth.identities.name (direct SQL join)
 *   4. Order buyer identity name (least specific)
 *
 * Email precedence (first non-empty wins):
 *   1. Survey response (email)
 *   2. auth.identities.contact_email
 *   3. auth.credentials email (LATERAL, type='email', latest)
 *   4. Profile-service lookup email
 *   5. Order buyer email (least specific)
 *
 * Guest Of: populated when the resolved attendee is clearly different from
 * the order buyer. Format: "Name <email>".
 */
export interface ResolvedAttendee {
  name: string;
  email: string;
  guestOf: string;
}

export interface ResolveAttendeeParams {
  surveyName: string | null;
  surveyEmail: string | null;
  identityName: string | null;
  identityContactEmail: string | null;
  identityCredentialEmail: string | null;
  profileName: string | null;
  profileEmail: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function sameAttendee(
  resName: string,
  resEmail: string,
  buyerName: string,
  buyerEmail: string
): boolean {
  if (resEmail && buyerEmail) {
    return resEmail.toLowerCase() === buyerEmail.toLowerCase();
  }
  if (resName && buyerName) {
    return resName.toLowerCase() === buyerName.toLowerCase();
  }
  return false;
}

export function resolveAttendee(params: ResolveAttendeeParams): ResolvedAttendee {
  const name =
    normalize(params.surveyName) ||
    normalize(params.profileName) ||
    normalize(params.identityName) ||
    normalize(params.buyerName);

  const email =
    normalize(params.surveyEmail) ||
    normalize(params.identityContactEmail) ||
    normalize(params.identityCredentialEmail) ||
    normalize(params.profileEmail) ||
    normalize(params.buyerEmail);

  const buyerName = normalize(params.buyerName);
  const buyerEmail = normalize(params.buyerEmail);

  let guestOf = '';
  const hasResolvedInfo = name || email;
  const hasBuyerInfo = buyerName || buyerEmail;

  if (hasResolvedInfo && hasBuyerInfo && !sameAttendee(name, email, buyerName, buyerEmail)) {
    const parts: string[] = [];
    if (buyerName) parts.push(buyerName);
    if (buyerEmail) parts.push(`<${buyerEmail}>`);
    guestOf = parts.join(' ');
  }

  return { name, email, guestOf };
}
