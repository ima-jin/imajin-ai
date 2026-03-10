// Text message (E2EE)
export type TextContent = { type?: "text"; text: string; encrypted?: string; nonce?: string };

// Voice message
export type VoiceContent = {
  type: "voice";
  assetId: string;           // media service asset ID
  transcript: string;        // Whisper transcript
  durationMs: number;        // audio duration
  waveform?: number[];       // optional visualization data
};

// Media message
export type MediaContent = {
  type: "media";
  assetId: string;           // media service asset ID
  filename: string;
  mimeType: string;
  size: number;
  width?: number;            // for images
  height?: number;           // for images
  caption?: string;          // optional text caption
};

// Location message
export type LocationContent = {
  type: "location";
  lat: number;
  lng: number;
  label?: string;            // human-readable place name
  accuracy?: number;         // meters
};

export type MessageContent = TextContent | VoiceContent | MediaContent | LocationContent;
