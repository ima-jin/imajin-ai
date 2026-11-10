import { NextResponse } from 'next/server';
import { getClientIP, rateLimit } from '@imajin/config';
import {
  alphaSubmissionInput, ALPHA_CONFIRMATION, ALPHA_RATE_LIMIT, ALPHA_RATE_WINDOW_MS,
} from '@/src/lib/alpha/contract';
import { readAlphaBody } from '@/src/lib/alpha/read-body';
import { storeAlphaSubmission } from '@/src/lib/alpha/store';

const HEADERS = { 'Cache-Control': 'no-store' };

/** Public intake only: no session defaults, account creation or public read. */
export async function POST(request: Request) {
  const quota = rateLimit(`alpha:ip:${getClientIP(request)}`, ALPHA_RATE_LIMIT, ALPHA_RATE_WINDOW_MS);
  if (quota.limited) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, {
    status: 429, headers: { ...HEADERS, 'Retry-After': String(quota.retryAfter) },
  });

  let body: unknown;
  try {
    body = await readAlphaBody(request);
  } catch {
    return NextResponse.json({ error: 'Invalid or oversized request.' }, { status: 400, headers: HEADERS });
  }
  const parsed = alphaSubmissionInput.safeParse(body);
  if (!parsed.success) return NextResponse.json({
    error: 'Check your name, work email, company, choice and agent description (maximum 1000 characters).',
  }, { status: 400, headers: HEADERS });

  const { name, email, company, intent, purpose } = parsed.data;
  try {
    await storeAlphaSubmission({ name, email, company, intent, purpose });
    return NextResponse.json({ message: ALPHA_CONFIRMATION }, { status: 201, headers: HEADERS });
  } catch {
    // Database exceptions may contain input values. Do not log or return them.
    return NextResponse.json({ error: 'Could not save your request. Please try again later.' }, { status: 503, headers: HEADERS });
  }
}
