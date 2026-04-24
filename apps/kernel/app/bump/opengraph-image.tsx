import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const alt = 'Bump — connect in person';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0a',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '20px',
        }}
      >
        <div style={{ fontSize: 140, fontWeight: 900, color: 'white', letterSpacing: '-4px' }}>
          Bump?
        </div>
        <div style={{ fontSize: 200, lineHeight: 1 }}>
          🤜🤛
        </div>
      </div>
    ),
    { ...size }
  );
}
