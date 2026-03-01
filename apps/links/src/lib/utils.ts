/**
 * Generate a random ID with prefix
 */
export function generateId(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 15);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Validate handle format (lowercase, alphanumeric, underscores, 3-30 chars)
 */
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{3,30}$/.test(handle);
}

/**
 * Validate URL format
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract domain from referrer (privacy-preserving)
 */
export function extractDomain(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Standard JSON response helpers
 */
export function jsonResponse(data: any, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/**
 * Theme presets
 */
export const themePresets = {
  dark: {
    backgroundColor: '#1a1a1a',
    textColor: '#ffffff',
    buttonColor: '#ff8c00',
    buttonTextColor: '#000000',
    buttonStyle: 'pill',
  },
  light: {
    backgroundColor: '#ffffff',
    textColor: '#1a1a1a',
    buttonColor: '#007bff',
    buttonTextColor: '#ffffff',
    buttonStyle: 'rounded',
  },
  midnight: {
    backgroundColor: '#0d1117',
    textColor: '#c9d1d9',
    buttonColor: '#238636',
    buttonTextColor: '#ffffff',
    buttonStyle: 'rounded',
  },
  sunset: {
    backgroundColor: '#fef3c7',
    textColor: '#78350f',
    buttonColor: '#f59e0b',
    buttonTextColor: '#000000',
    buttonStyle: 'pill',
  },
  ocean: {
    backgroundColor: '#0f172a',
    textColor: '#e2e8f0',
    buttonColor: '#06b6d4',
    buttonTextColor: '#000000',
    buttonStyle: 'pill',
  },
};
