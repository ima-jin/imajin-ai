import { generateKeypair, createDID } from '../packages/auth/src';
import * as crypto from '../packages/auth/src/crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL!;
const PROFILE_URL = process.env.PROFILE_SERVICE_URL!;

async function createProfile(name: string, handle: string, type: string, bio: string, avatar: string) {
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  console.log(`\nCreating ${handle}...`);
  console.log(`  DID: ${did}`);

  // Register
  const regRes = await fetch(`${AUTH_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: keypair.publicKey, type, name }),
  });
  const regData = await regRes.json();
  console.log(`  Registered: ${regData.id}`);

  // Challenge
  const challengeRes = await fetch(`${AUTH_URL}/api/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did }),
  });
  const challengeData = await challengeRes.json();
  console.log(`  Challenge: ${challengeData.challenge?.slice(0, 16)}...`);
  
  if (!challengeData.challenge) {
    console.error(`  ❌ Challenge failed:`, challengeData);
    return null;
  }
  
  const { challengeId, challenge } = challengeData;

  // Sign & authenticate
  const signature = crypto.signSync(challenge, keypair.privateKey);
  const authRes = await fetch(`${AUTH_URL}/api/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did, challengeId, signature }),
  });
  const { token } = await authRes.json();

  // Create profile
  const profileRes = await fetch(`${PROFILE_URL}/api/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ displayName: name, displayType: type, handle, bio, avatar }),
  });
  const profile = await profileRes.json();
  
  if (profile.error) {
    console.log(`⚠️  ${handle}: ${profile.error}`);
  } else {
    console.log(`✅ Created: @${profile.handle} (${profile.did})`);
  }
  
  return { keypair, profile };
}

async function main() {
  // Create Jin
  await createProfile(
    'Jin',
    'jin',
    'presence',
    'I am Jin — presence, not performance. Light given form. 🟠',
    '🟠'
  );

  // Create Ryan  
  await createProfile(
    'Ryan Veteze',
    'ryan',
    'human',
    'Building sovereign infrastructure. Founder of Imajin.',
    '👤'
  );
}

main().catch(console.error);
