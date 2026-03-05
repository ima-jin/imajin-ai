/**
 * Usage metering + rate limiting for the input service.
 * 
 * Tracks compute consumption per DID and enforces configurable rate limits.
 * Rate limits use an in-memory sliding window (resets on restart — acceptable for now,
 * graduate to Redis when needed).
 */

// --- Rate Limiting (in-memory sliding window) ---

interface RateWindow {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateWindow>();

// Configurable limits per DID per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_TRANSCRIPTIONS = parseInt(process.env.RATE_LIMIT_TRANSCRIPTIONS || '30', 10);
const RATE_LIMIT_UPLOADS = parseInt(process.env.RATE_LIMIT_UPLOADS || '100', 10);

/**
 * Check rate limit for a DID + action type.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkRateLimit(
  did: string,
  action: 'transcribe' | 'upload'
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const limit = action === 'transcribe' ? RATE_LIMIT_TRANSCRIPTIONS : RATE_LIMIT_UPLOADS;
  const key = `${did}:${action}`;
  const now = Date.now();

  let window = rateLimits.get(key);

  // Reset expired windows
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(key, window);
  }

  if (window.count >= limit) {
    return { allowed: false, retryAfterMs: window.resetAt - now };
  }

  window.count++;
  return { allowed: true };
}

/**
 * Get current usage stats for a DID.
 */
export function getUsageStats(did: string) {
  const now = Date.now();
  const transcribeWindow = rateLimits.get(`${did}:transcribe`);
  const uploadWindow = rateLimits.get(`${did}:upload`);

  return {
    transcriptions: {
      used: transcribeWindow && now < transcribeWindow.resetAt ? transcribeWindow.count : 0,
      limit: RATE_LIMIT_TRANSCRIPTIONS,
      resetsAt: transcribeWindow?.resetAt || null,
    },
    uploads: {
      used: uploadWindow && now < uploadWindow.resetAt ? uploadWindow.count : 0,
      limit: RATE_LIMIT_UPLOADS,
      resetsAt: uploadWindow?.resetAt || null,
    },
  };
}

// Clean up expired entries periodically (prevent memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of rateLimits.entries()) {
    if (now >= window.resetAt) {
      rateLimits.delete(key);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
