/**
 * Dark theme email wrapper with IMAJIN footer.
 * Pass inner HTML content (the body rows) to wrap in the outer shell.
 */
export function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
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

          ${content}

          <!-- Brand -->
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
              <p style="margin:0 0 16px;font-size:12px;color:#52525b;">The internet that pays you back</p>
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                Part of the <a href="https://imajin.ai" style="color:#52525b;text-decoration:underline;">Imajin</a> sovereign network
                &nbsp;·&nbsp;
                <a href="https://app.dfos.com/j/6hnk8e9r9z8eht3k48z474" style="color:#3f3f46;text-decoration:underline;">DFOS Community</a>
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
</html>`;
}
