import { db } from '../src/db';
import { partners, registrationTokens } from '../src/db/schema';
import { generateId, generateToken } from '../src/lib/utils';

async function seed() {
  console.log('🌱 Seeding database...');

  try {
    // Create a demo partner
    const [partner] = await db.insert(partners).values({
      id: generateId('partner'),
      name: 'Demo Repair Company',
      slug: 'demo-repair',
      logoUrl: null,
      contactPhone: '(555) 123-4567',
      contactEmail: 'contact@demorepair.com',
      responseWindowCopy: "We'll contact you within 24 hours",
      webhookUrl: null,
    }).returning();

    console.log('✅ Created demo partner:', partner.id);

    // Create some registration tokens
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      const [token] = await db.insert(registrationTokens).values({
        id: generateToken(),
        partnerId: partner.id,
        label: `Batch ${i + 1}`,
        scans: 0,
      }).returning();
      tokens.push(token);
    }

    console.log(`✅ Created ${tokens.length} registration tokens`);
    console.log('\n📋 Test Tokens:');
    tokens.forEach((token, i) => {
      console.log(`  ${i + 1}. Token: ${token.id}`);
      console.log(`     URL: https://fixready.imajin.ai/go/${token.id}`);
    });

    console.log('\n✅ Seeding complete!');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
