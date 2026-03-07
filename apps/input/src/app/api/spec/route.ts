import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

const spec = `openapi: "3.1.0"
info:
  title: imajin input
  version: "1.0.0"
  description: Media upload relay and Whisper speech-to-text transcription.
servers:
  - url: https://input.imajin.ai
    description: production
  - url: https://dev-input.imajin.ai
    description: dev
paths:
  /api/upload:
    post:
      summary: Upload media
      description: Upload and relay media files to the media service
  /api/transcribe:
    post:
      summary: Transcribe audio
      description: Speech-to-text via Whisper
  /api/health:
    get:
      summary: Health check
  /api/usage:
    get:
      summary: Usage stats
`;

export async function GET() {
  return new NextResponse(spec, {
    headers: { "Content-Type": "text/yaml" },
  });
}
