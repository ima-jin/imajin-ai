import { generateKeypair, createDID } from '../packages/auth/src';
import * as crypto from '../packages/auth/src/crypto';

async function main() {
  // Create organizer identity
  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  console.log('Organizer DID:', did);
  
  // Register
  await fetch('http://localhost:3003/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: keypair.publicKey, type: 'human', name: 'Event Creator' }),
  });
  
  // Challenge
  const cr = await fetch('http://localhost:3003/api/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did }),
  });
  const { challengeId, challenge } = await cr.json();
  
  // Sign & Auth
  const signature = crypto.signSync(challenge, keypair.privateKey);
  const ar = await fetch('http://localhost:3003/api/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: did, challengeId, signature }),
  });
  const { token } = await ar.json();
  console.log('Got token');
  
  // Create Jin's Launch Party
  const er = await fetch('http://localhost:3007/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      title: "Jin's Launch Party",
      description: 'The genesis event. First transaction on the sovereign network. April 1, 2026.',
      startsAt: '2026-04-01T19:00:00-04:00',
      endsAt: '2026-04-01T23:00:00-04:00',
      city: 'Toronto',
      isVirtual: false,
      tickets: [
        { name: 'Virtual', description: 'Watch online', price: 100, quantity: null },
        { name: 'Physical', description: 'Be there in person', price: 1000, quantity: 500 },
      ],
    }),
  });
  
  const result = await er.json();
  
  if (result.error) {
    console.error('Error:', result.error);
    return;
  }
  
  console.log('\n✅ Event created!');
  console.log('Event ID:', result.event.id);
  console.log('Event DID:', result.event.did);
  console.log('Title:', result.event.title);
  console.log('Ticket types:', result.ticketTypes.length);
  
  result.ticketTypes.forEach((tt: any) => {
    console.log(`  - ${tt.name}: $${tt.price / 100} (${tt.quantity || 'unlimited'})`);
  });
}

main().catch(console.error);
