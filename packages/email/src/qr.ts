import QRCode from 'qrcode';

/**
 * Generate a QR code as a base64 data URI.
 * Returns the full data:image/png;base64,... string for embedding in HTML.
 */
export async function generateQRCode(data: string): Promise<string> {
  try {
    return await QRCode.toDataURL(data, {
      width: 200,
      margin: 1,
      color: {
        dark: '#ffffff',
        light: '#1a1a1a',
      },
    });
  } catch (error) {
    console.error('QR code generation failed:', error);
    return '';
  }
}
