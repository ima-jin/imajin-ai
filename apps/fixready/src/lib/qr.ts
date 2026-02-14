import QRCode from 'qrcode';

export interface QRCodeOptions {
  width?: number;
  margin?: number;
  darkColor?: string;
  lightColor?: string;
}

export async function generateQRCode(
  token: string,
  options: QRCodeOptions = {}
): Promise<Buffer> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://fixready.imajin.ai';
  const url = `${baseUrl}/go/${token}`;

  const {
    width = 400,
    margin = 2,
    darkColor = '#000000',
    lightColor = '#FFFFFF',
  } = options;

  return QRCode.toBuffer(url, {
    type: 'png',
    width,
    margin,
    color: {
      dark: darkColor,
      light: lightColor,
    },
  });
}

export async function generateQRCodeDataURL(
  token: string,
  options: QRCodeOptions = {}
): Promise<string> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://fixready.imajin.ai';
  const url = `${baseUrl}/go/${token}`;

  const {
    width = 400,
    margin = 2,
    darkColor = '#000000',
    lightColor = '#FFFFFF',
  } = options;

  return QRCode.toDataURL(url, {
    type: 'image/png',
    width,
    margin,
    color: {
      dark: darkColor,
      light: lightColor,
    },
  });
}
