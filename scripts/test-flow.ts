/**
 * Test the full auth + profile flow
 */
import { generateKeypair, createDID } from '../packages/auth/src';
import * as crypto from '../packages/auth/src/crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL!;
const PROFILE_URL = process.env.PROFILE_SERVICE_URL!;

async function main() {
  console.log('🔐 Testing Auth + Profile Flow\n');

  // 1. Generate keypair
  console.log('1. Generating keypair...');
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  console.log(`   Public Key: ${keypair.publicKey.slice(0, 16)}...`);
  console.log(`   DID: ${did}\n`);

  // 2. Register with auth
  console.log('2. Registering identity...');
  const registerRes = await fetch(`${AUTH_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: keypair.publicKey,
      type: 'human',
      name: 'Test User',
    }),
  });
  const registerData = await registerRes.json();
  console.log(`   Response: ${JSON.stringify(registerData)}\n`);

  if (!registerData.id) {
    console.error('❌ Registration failed');
    process.exit(1);
  }

  // 3. Get challenge
  console.log('3. Getting challenge...');
  const challengeRes = await fetch(`${AUTH_URL}/api/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did }),
  });
  const challengeData = await challengeRes.json();
  console.log(`   Challenge ID: ${challengeData.challengeId}`);
  console.log(`   Challenge: ${challengeData.challenge?.slice(0, 16)}...\n`);

  if (!challengeData.challenge) {
    console.error('❌ Challenge failed');
    process.exit(1);
  }

  // 4. Sign challenge (raw signature of challenge string)
  console.log('4. Signing challenge...');
  const signature = crypto.signSync(challengeData.challenge, keypair.privateKey);
  console.log(`   Signature: ${signature.slice(0, 32)}...\n`);

  // 5. Authenticate
  console.log('5. Authenticating...');
  const authRes = await fetch(`${AUTH_URL}/api/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: did,
      challengeId: challengeData.challengeId,
      signature,
    }),
  });
  const authData = await authRes.json();
  console.log(`   Token: ${authData.token?.slice(0, 20)}...`);
  console.log(`   Expires: ${authData.expiresAt}\n`);

  if (!authData.token) {
    console.error('❌ Authentication failed:', authData);
    process.exit(1);
  }

  // 6. Create profile
  console.log('6. Creating profile...');
  const profileRes = await fetch(`${PROFILE_URL}/api/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authData.token}`,
    },
    body: JSON.stringify({
      displayName: 'Test User',
      displayType: 'human',
      handle: `test_${Date.now()}`,
      bio: 'Just testing the sovereign stack',
    }),
  });
  const profileData = await profileRes.json();
  console.log(`   Profile: ${JSON.stringify(profileData, null, 2)}\n`);

  if (profileData.error) {
    console.error('❌ Profile creation failed:', profileData.error);
    process.exit(1);
  }

  console.log('✅ Full flow complete!');
  console.log(`   DID: ${did}`);
  console.log(`   Handle: ${profileData.handle}`);
  console.log(`   Token: ${authData.token.slice(0, 20)}...`);
}

main().catch(console.error);
