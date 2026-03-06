import { emailWrapper } from './base';

interface TrustGraphInviteData {
  inviterName: string;
  inviterHandle?: string;
  inviteUrl: string;
  note?: string;
  expiresAt?: string;
}

export function trustGraphInviteEmail(data: TrustGraphInviteData): string {
  const inviterDisplay = data.inviterHandle
    ? `@${data.inviterHandle}`
    : data.inviterName;

  const noteSection = data.note
    ? `
          <!-- Personal note -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <blockquote style="margin:0;padding:16px 20px;background-color:#1a1a1a;border-left:3px solid #3f3f46;border-radius:0 6px 6px 0;">
                <p style="margin:0;font-size:14px;color:#a1a1aa;line-height:1.6;font-style:italic;">"${data.note}"</p>
                <p style="margin:8px 0 0;font-size:12px;color:#52525b;">— ${inviterDisplay}</p>
              </blockquote>
            </td>
          </tr>`
    : '';

  const expirySection = data.expiresAt
    ? `<p style="margin:12px 0 0;font-size:13px;color:#52525b;line-height:1.5;">This invitation expires on ${data.expiresAt}.</p>`
    : '';

  const content = `
          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">You're invited to Imajin</h1>
              <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;"><strong style="color:#ffffff;">${inviterDisplay}</strong> invited you to join the Imajin network.</p>
            </td>
          </tr>
          ${noteSection}
          <!-- CTA Button -->
          <tr>
            <td style="background-color:#111111;padding:24px 32px;text-align:center;">
              <a href="${data.inviteUrl}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Accept Invitation →</a>
              ${expirySection}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;text-align:center;">
              </div>
            </td>
          </tr>`;

  return emailWrapper(content);
}
