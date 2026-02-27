/**
 * Auth utilities - validate tokens against auth service
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export interface Identity {
  id: string;
  type: 'human' | 'agent';
  name?: string;
}

export interface ValidateResult {
  valid: boolean;
  identity?: Identity;
}

export async function validateToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { valid: false };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Token validation failed:', error);
    return { valid: false };
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7);
}

export async function requireAuth(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  const token = extractToken(request);

  if (!token) {
    return { error: 'Missing authorization token', status: 401 };
  }

  const result = await validateToken(token);

  if (!result.valid || !result.identity) {
    return { error: 'Invalid or expired token', status: 401 };
  }

  return { identity: result.identity };
}
