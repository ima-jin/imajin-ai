import { emailWrapper } from '@imajin/email';

export function verificationEmail(verifyUrl: string): string {
  const content = `
          <!-- Header -->
          <tr>
            <td style="background-color:#111111;padding:32px 32px 24px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Confirm your email</h1>
              <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">You're one click away from joining the Imajin updates list.</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 24px;">
              <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">Click the button below to confirm your email address. This link expires in 7 days.</p>
              <div style="text-align:center;">
                <a href="${verifyUrl}" style="display:inline-block;background-color:#f59e0b;color:#000000;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Confirm my email →</a>
              </div>
              <p style="margin:24px 0 0;font-size:13px;color:#52525b;line-height:1.6;">Or copy and paste this link into your browser:<br/>
                <a href="${verifyUrl}" style="color:#71717a;word-break:break-all;">${verifyUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
              <div style="border-top:1px solid #262626;padding-top:20px;">
                <p style="margin:0;font-size:12px;color:#3f3f46;text-align:center;">If you didn't sign up for Imajin updates, you can safely ignore this email.</p>
              </div>
            </td>
          </tr>
  `;
  return emailWrapper(content);
}

export const verificationEmailText = (verifyUrl: string): string =>
  `Confirm your email — Imajin\n\nYou're one click away from joining the Imajin updates list.\n\nConfirm your email: ${verifyUrl}\n\nThis link expires in 7 days. If you didn't sign up, ignore this email.\n\nImajin — The internet that pays you back\nhttps://imajin.ai`;
