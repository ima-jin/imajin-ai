export { sendEmail } from '@imajin/email';

// =============================================================================
// Coffee Tip Email Templates
// =============================================================================

interface TipReceivedData {
  recipientName: string;
  fromName: string;
  amount: string;
  message?: string;
  pageUrl: string;
}

export function tipReceivedEmail(data: TipReceivedData): string {
  const messageBlock = data.message
    ? `<tr>
        <td style="padding:16px 0 0;">
          <div style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;padding:16px;">
            <p style="margin:0 0 4px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Message</p>
            <p style="margin:0;font-size:15px;color:#e4e4e7;font-style:italic;line-height:1.5;">"${data.message}"</p>
          </div>
        </td>
      </tr>`
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
          <tr>
            <td style="background-color:#111111;border-radius:8px;padding:32px;">
              <p style="margin:0 0 8px;font-size:32px;">☕</p>
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#ffffff;">You got a tip!</h1>
              <p style="margin:0 0 24px;font-size:16px;color:#a1a1aa;line-height:1.5;"><strong style="color:#ffffff;">${data.fromName}</strong> just tipped you <strong style="color:#f59e0b;">${data.amount}</strong></p>
              ${messageBlock}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:24px 0 0;text-align:center;">
                    <a href="${data.pageUrl}" style="display:inline-block;background-color:#ffffff;color:#000000;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View Your Page →</a>
                  </td>
                </tr>
              </table>
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

interface TipSentData {
  fromName: string;
  recipientName: string;
  amount: string;
  pageUrl: string;
}

export function tipSentEmail(data: TipSentData): string {
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
              <p style="margin:0 0 8px;font-size:32px;">🧡</p>
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#ffffff;">Thanks for the tip!</h1>
              <p style="margin:0 0 24px;font-size:16px;color:#a1a1aa;line-height:1.5;">You sent <strong style="color:#f59e0b;">${data.amount}</strong> to <strong style="color:#ffffff;">${data.recipientName}</strong></p>
              <div style="background-color:#1a1a1a;border-radius:8px;border:1px solid #262626;padding:16px;text-align:center;">
                <p style="margin:0;font-size:14px;color:#a1a1aa;line-height:1.6;">Your support goes directly to the creator.<br/>No middlemen. Full attribution via <strong style="color:#f59e0b;">.fair</strong></p>
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
