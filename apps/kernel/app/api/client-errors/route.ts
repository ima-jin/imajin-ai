import { NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { nanoid } from 'nanoid';

const log = createLogger('kernel');

interface ClientErrorPayload {
  message: string;
  stack: string;
  url: string;
  userAgent: string;
  componentStack?: string;
  timestamp: string;
}

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 500;
const MAX_USER_AGENT = 500;
const MAX_COMPONENT_STACK = 2000;

function stripControlChars(input: string): string {
  return input.replaceAll(/[\x00-\x1F\x7F]/g, '');
}

function stripHtmlTags(input: string): string {
  let result = '';
  let inTag = false;
  for (const char of input) {
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
    } else if (!inTag) {
      result += char;
    }
  }
  return result;
}

function sanitizeString(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  let value = input;
  value = stripControlChars(value);
  value = stripHtmlTags(value);
  value = value.trim();
  if (value.length > maxLength) {
    value = value.slice(0, maxLength);
  }
  return value;
}

function isValidUrl(url: string): boolean {
  if (url.startsWith('/')) return true;
  if (url.startsWith('http://') || url.startsWith('https://')) return true;
  return false;
}

function validatePayload(body: unknown): ClientErrorPayload | null {
  if (body === null || typeof body !== 'object') return null;

  const raw = body as Record<string, unknown>;

  const message = sanitizeString(raw.message, MAX_MESSAGE);
  if (message.length === 0) return null;

  const stack = sanitizeString(raw.stack, MAX_STACK);
  const url = sanitizeString(raw.url, MAX_URL);
  if (url.length === 0 || !isValidUrl(url)) return null;

  const userAgent = sanitizeString(raw.userAgent, MAX_USER_AGENT);
  const componentStack = sanitizeString(raw.componentStack, MAX_COMPONENT_STACK);

  const timestamp = sanitizeString(raw.timestamp, 64);
  if (timestamp.length === 0) return null;

  return {
    message,
    stack,
    url,
    userAgent,
    componentStack: componentStack.length > 0 ? componentStack : undefined,
    timestamp,
  };
}

export async function POST(request: Request) {
  const ip = getClientIP(request);
  const limitResult = rateLimit(`client-errors:${ip}`, 10, 60_000);

  if (limitResult.limited) {
    return new NextResponse(null, {
      status: 429,
      headers: { 'Retry-After': String(limitResult.retryAfter) },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const payload = validatePayload(body);
  if (!payload) {
    return new NextResponse(null, { status: 400 });
  }

  let did: string | null = null;
  try {
    const cookieHeader = request.headers.get('cookie');
    const session = await getSessionFromCookies(cookieHeader);
    if (session) {
      did = session.did;
    }
  } catch {
    // Auth failures must not break error logging
  }

  try {
    const sql = getClient();
    const id = `cerr_${nanoid(16)}`;
    const metadata = JSON.stringify({
      userAgent: payload.userAgent,
      componentStack: payload.componentStack,
      timestamp: payload.timestamp,
    });

    await sql`
      INSERT INTO registry.logs
        (id, source, service, level, message, path, error_message, did, metadata, created_at)
      VALUES
        (
          ${id},
          'browser',
          'client',
          'error',
          ${payload.message},
          ${payload.url},
          ${payload.stack.length > 0 ? payload.stack : null},
          ${did},
          ${metadata}::jsonb,
          now()
        )
    `;
  } catch (error) {
    log.error({ err: String(error), ip }, 'failed to write client error to registry.logs');
  }

  return new NextResponse(null, { status: 204 });
}
