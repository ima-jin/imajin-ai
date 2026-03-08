/**
 * Seed script: AgentCon Toronto deck — "The Architecture of Trust"
 * 
 * Chronological build story. Each slide is a choice that seemed practical.
 * The audience discovers the pattern the same way the builder did.
 *
 * Usage: DATABASE_URL="..." npx tsx scripts/seed-agentcon.ts
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { courses, modules, lessons } from '../src/db/schema';

const CREATOR_DID = process.env.CREATOR_DID || 'did:imajin:ryan';

function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

const slides = [
  // --- ACT 1: THE SETUP ---
  {
    title: '35 days ago I started building.',
    content: "I didn't have a deck. I didn't have a pitch.\n\nI had a glowing cube, a Postgres database, and a thesis I couldn't quite articulate yet.",
    metadata: { layout: 'center' },
  },
  {
    title: 'Day 1 — A body for AI.',
    content: 'Unit 8×8×8. 512 RGBW LEDs. An AI presence that expresses through light, not text.\n\nThe question was simple: what happens when AI takes up physical space?\n\nComputers became invisible. Invisible became unaccountable. What if you could *see* it thinking?',
    metadata: {
      layout: 'left',
      subtitle: 'February 1, 2026',
    },
  },
  {
    title: 'Day 3 — The first decision.',
    content: "I needed auth. The simplest possible kind.\n\nNot email and password. Not OAuth. Not \"Sign in with Google.\"\n\nEd25519 keypair → DID. That's it.\n\nSame primitive for humans and agents. If you can hold a key, you can have an identity. No one else involved.",
    metadata: {
      layout: 'left',
      subtitle: 'February 13, 2026',
    },
  },
  {
    title: 'Day 3 — The second decision.',
    content: "Same afternoon. Payments.\n\nNot \"how do we monetize.\" Just plumbing.\n\nIf identity is a keypair, then a transaction is a signed message between two keypairs. Stripe for fiat. Solana for crypto. Same interface, different rails.\n\nTwo commits. Auth and Pay. Both DID-based from line one.",
    metadata: {
      layout: 'left',
      subtitle: 'Still February 13',
      items: [
        'feat(auth): add sovereign identity package and service',
        'feat: add pay package and service, wire Ed25519 crypto',
      ],
    },
  },

  // --- ACT 2: THE BUILD ---
  {
    title: 'Day 4 — The registry.',
    content: "If anyone can have an identity, anyone can run a node.\n\nFederated, not decentralized. Honest about the tradeoff.\n\nCentral registry for discovery now. On-chain later. Mesh trust eventually.\n\nThe exit door is always open. The registry is open source. Nodes work locally without it.",
    metadata: {
      layout: 'left',
      subtitle: 'February 14, 2026',
    },
  },
  {
    title: 'Day 7 — First ticket sold.',
    content: 'events.imajin.ai → pay.imajin.ai → Stripe → webhook → ticket created.\n\nIdentity → payment → attribution → ticket. All DID-scoped.\n\nThe whole thesis, working as code.',
    metadata: {
      layout: 'center',
      subtitle: 'February 20, 2026',
    },
  },
  {
    title: 'Day 14 — The server comes home.',
    content: "HP ProLiant ML350p Gen8. My first real Linux server. In my house.\n\nCaddy reverse proxy. PM2 process management. Local Postgres.\n\nThe platform was no longer on Vercel's servers. It was on hardware I own, behind a domain I control.",
    metadata: {
      layout: 'left',
      subtitle: 'February 24, 2026',
    },
  },
  {
    title: 'Day 16 — Invite only.',
    content: "No public signup. You need an invite code.\n\nThe invite IS the trust boundary.\n\nBuying a ticket to an event? The ticket IS the invite. No code needed — the transaction creates the trust relationship.\n\nJin was Account #1. I accepted Jin's genesis invite to become Account #2.",
    metadata: {
      layout: 'left',
      subtitle: 'February 26, 2026',
    },
  },

  // --- ACT 3: THE ACCELERATION ---
  {
    title: 'Day 20 — External contributors.',
    content: "A Staff Engineer at Slack opened the first PRs.\n\nThe codebase was legible enough for a stranger to contribute to in 20 days.\n\nBranch protection added. CI pipeline on self-hosted runner. The project had gravity.",
    metadata: {
      layout: 'left',
      subtitle: 'March 2, 2026',
    },
  },
  {
    title: 'Day 23 — Parallel builds.',
    content: "7 features shipped in 90 minutes using parallel coding agents.\n\nMedia service. .fair attribution package. Rich chat. Input service with Whisper transcription. OpenAPI specs for all services.\n\n~4,800 lines in a day.",
    metadata: {
      layout: 'left',
      subtitle: 'March 5, 2026',
    },
  },
  {
    title: 'Day 25 — Someone else uses it.',
    content: "Not a developer. A real person.\n\nCreated a real event. 6 ticket tiers. Survey gating. E-Transfer payments.\n\nThe platform was being *used*, not just built.",
    metadata: {
      layout: 'left',
      subtitle: 'March 6, 2026',
    },
  },

  // --- ACT 4: THE REVEAL ---
  {
    title: 'Then I realized what I built.',
    content: "I started from the human angle — auth, pay, connect, share.\n\nBut the agent layer was always implicit.\n\nIdentity + trust graph + inference = sovereign agent gateway.\n\nThe trust boundaries that protect people are the same boundaries that make agent actions safe.",
    metadata: { layout: 'center' },
  },
  {
    title: 'The pattern I followed.',
    content: "Every choice seemed practical at the time. In sequence, they reveal something else.",
    metadata: {
      layout: 'left',
      items: [
        'Identity first — before features, before UI. Who are you, without trusting anyone else?',
        'Payments as plumbing — not monetization. Infrastructure. The ability to transact is as fundamental as the ability to identify.',
        'Trust as topology — connections aren\'t social. They\'re structural. They define what you can see and what actions are allowed.',
        'Attribution as memory — .fair manifests. Every interaction has provenance. Who made it, who gets compensated.',
        'Hardware as anchor — you can\'t have a physical presence device that phones home to someone else\'s cloud.',
      ],
    },
  },
  {
    title: '14 services. $1,589.',
    content: "Traditional estimate: $932,316 over 16.4 months with a 3-person team.\n\n190 human hours. 25 build days. 68,024 lines of code.\n\nAll open source. All self-hosted. All trust-gated.",
    metadata: {
      layout: 'left',
      subtitle: 'As of March 8, 2026',
      items: [
        'auth — keypair identity',
        'pay — settlement engine',
        'profile — sovereign profiles',
        'registry — node discovery',
        'connections — trust graph',
        'events — ticketing',
        'chat — real-time messaging',
        'media — DID-pegged storage + .fair',
        'input — voice transcription',
        'learn — courses + presentations',
        'coffee — direct support',
        'links — link pages',
        'dykil — surveys',
        'www — landing + essays',
      ],
    },
  },

  // --- ACT 5: THE THESIS ---
  {
    title: 'Start from the human.',
    content: "Everyone in this room is building agents to operate better *within* platforms.\n\nWhat if the platform was trust infrastructure that agents and humans share?\n\nSame keypairs. Same DIDs. Same trust graph. Every interaction typed — you always know if you're talking to a human or an agent.\n\nThe agent layer doesn't need its own architecture. It emerges from proper trust boundaries.",
    metadata: { layout: 'center' },
  },
  {
    title: '',
    content: "\"The best way to make something better within a system that has absolute control over everything is likely to make a completely free and easy to use system that just works on its own frequency.\"",
    metadata: {
      layout: 'center',
      cta: { text: 'imajin.ai', href: 'https://imajin.ai' },
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url);
  const db = drizzle(sql);

  // Ensure schema exists
  await sql`CREATE SCHEMA IF NOT EXISTS learn`;

  const courseId = generateId('crs');
  const moduleId = generateId('mod');

  console.log('\nSeeding: AgentCon — The Architecture of Trust...');

  await db.insert(courses).values({
    id: courseId,
    creatorDid: CREATOR_DID,
    title: 'AgentCon: The Architecture of Trust',
    description: '35 days. 14 services. $1,589 in inference costs. How building for humans first created a sovereign agent gateway.',
    slug: 'agentcon-architecture-of-trust',
    price: 0,
    currency: 'CAD',
    visibility: 'public',
    tags: ['agentcon', 'presentation', 'trust', 'sovereign', 'agents'],
    status: 'published',
    metadata: {},
  });

  console.log(`  Course: ${courseId} (agentcon-architecture-of-trust)`);

  await db.insert(modules).values({
    id: moduleId,
    courseId,
    title: 'The Architecture of Trust',
    description: 'AgentCon Toronto — March 14, 2026',
    sortOrder: 0,
  });

  console.log(`  Module: ${moduleId} (The Architecture of Trust) — ${slides.length} slides`);

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const lessonId = generateId('lsn');
    await db.insert(lessons).values({
      id: lessonId,
      moduleId,
      title: slide.title || `Slide ${i + 1}`,
      contentType: 'slide',
      content: slide.content,
      metadata: slide.metadata,
      sortOrder: i,
    });
  }

  console.log(`\n✅ Seed complete!`);
  console.log(`   agentcon-architecture-of-trust — ${slides.length} slides`);
  console.log(`\n   Present: learn.imajin.ai/course/agentcon-architecture-of-trust/present`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
