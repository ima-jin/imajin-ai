import { NextRequest } from 'next/server';
import { db, profiles } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';

// Reserved handles that cannot be claimed
const RESERVED_HANDLES = [
  'admin', 'api', 'app', 'auth', 'blog', 'coffee', 'connect', 'dashboard',
  'docs', 'events', 'help', 'home', 'imajin', 'inbox', 'links', 'login',
  'logout', 'mail', 'news', 'pay', 'profile', 'register', 'search', 'settings',
  'signup', 'status', 'support', 'team', 'www'
];

// Base58 encoding for DIDs
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function isValidHandle(handle: string): boolean {
  // Lowercase, alphanumeric + hyphens, 3-30 chars
  if (!/^[a-z0-9\-]{3,30}$/.test(handle)) {
    return false;
  }

  // No leading/trailing hyphens
  if (handle.startsWith('-') || handle.endsWith('-')) {
    return false;
  }

  // No consecutive hyphens
  if (handle.includes('--')) {
    return false;
  }

  // Not reserved
  if (RESERVED_HANDLES.includes(handle)) {
    return false;
  }

  return true;
}

/**
 * POST /api/register - Create a new profile (no auth required)
 * Accepts: { publicKey (hex), handle?, displayName, bio?, avatar? }
 * Returns: { did, handle, displayName }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { publicKey, handle, displayName, bio, avatar } = body;

    // Validate required fields
    if (!publicKey || typeof publicKey !== 'string') {
      return errorResponse('publicKey (hex string) is required');
    }

    if (!displayName || typeof displayName !== 'string') {
      return errorResponse('displayName is required');
    }

    // Generate DID from public key
    const publicKeyBytes = hexToBytes(publicKey);
    const publicKeyBase58 = base58Encode(publicKeyBytes);
    const did = `did:imajin:${publicKeyBase58}`;

    // Validate handle if provided
    if (handle) {
      if (!isValidHandle(handle)) {
        return errorResponse('Handle must be 3-30 characters, lowercase alphanumeric + hyphens, no reserved words');
      }

      // Check handle uniqueness
      const handleTaken = await db.query.profiles.findFirst({
        where: (profiles, { eq }) => eq(profiles.handle, handle),
      });

      if (handleTaken) {
        return errorResponse('Handle is already taken', 409);
      }
    }

    // Check if DID already exists
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.did, did),
    });

    if (existing) {
      return errorResponse('Profile already exists for this public key', 409);
    }

    // Create profile with 'human' as default display type
    const result = await db.insert(profiles).values({
      did,
      displayName,
      displayType: 'human',
      avatar: avatar || null,
      bio: bio || null,
      handle: handle || null,
      metadata: {},
    }).returning();

    const profile = Array.isArray(result) ? result[0] : result;

    return jsonResponse({
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
    }, 201);
  } catch (error) {
    console.error('Registration failed:', error);
    return errorResponse('Registration failed', 500);
  }
}
