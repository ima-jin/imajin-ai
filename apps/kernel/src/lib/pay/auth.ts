/**
 * Auth Integration
 * 
 * Validates tokens with the auth service.
 * Optional - payments can work without auth for anonymous/guest checkout.
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export interface AuthValidation {
  valid: boolean;
  identity?: {
    id: string;
    publicKey: string;
    type: 'human' | 'agent';
  };
  error?: string;
}

/**
 * Validate a token with the auth service
 */
export async function validateToken(token: string): Promise<AuthValidation> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    
    if (!response.ok) {
      return { valid: false, error: 'Auth service error' };
    }
    
    return await response.json();
  } catch (error) {
    // Auth service unavailable - allow anonymous operations
    console.warn('Auth service unavailable:', error);
    return { valid: false, error: 'Auth service unavailable' };
  }
}

/**
 * Extract token from Authorization header
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  
  return null;
}
