function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function onboardEmail({ verifyUrl, context, name, onBehalfOf }: {
  verifyUrl: string; context?: string; name?: string; onBehalfOf?: string;
}): string {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const contextLine = context ? `<p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">You're about to <strong style="color:#ffffff;">${context}</strong>. Verify your email to continue.</p>` : '<p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">Verify your email to continue.</p>';

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
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">${greeting}</p>
              ${contextLine}
              ${onBehalfOf ? `<p>Sent by this Imajin node on behalf of ${escapeHtml(onBehalfOf)}.</p>` : ''}
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}" style="display:inline-block;background-color:#f59e0b;color:#000000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Verify Email & Continue →</a>
              </div>
              <p style="margin:0;font-size:13px;color:#52525b;text-align:center;">This link expires in 15 minutes.</p>
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

