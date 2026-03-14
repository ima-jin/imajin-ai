import { NextRequest, NextResponse } from "next/server";

// Match *.imajin.ai, dev-*.imajin.ai, and localhost for dev
const ORIGIN_PATTERN = /^https:\/\/(dev-)?[a-z-]+\.imajin\.ai$/;
const LOCAL_PATTERN = /^http:\/\/localhost:\d+$/;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ORIGIN_PATTERN.test(origin)) return true;
  if (process.env.NODE_ENV !== "production" && LOCAL_PATTERN.test(origin)) return true;
  return false;
}

export function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = isAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Caller-DID",
  };
}

export function corsOptions(request: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function withCors(response: NextResponse, request: NextRequest): NextResponse {
  const headers = corsHeaders(request);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export function validateOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  // Allow server-side calls (no origin header)
  if (!origin) return true;
  return isAllowedOrigin(origin);
}
