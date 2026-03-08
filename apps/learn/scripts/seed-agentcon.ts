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
  // --- ACT 1: THE CONSTRAINT ---
  {
    title: 'I\'ve been trying to build this for 30 years.',
    content: "I ran a BBS at fifteen. Three phone lines, three hundred people finding each other before the web existed.\n\nI've seen the whole arc — the wonder, the capture, the extraction. I've known what needs to exist. The architecture has been in my head for decades.\n\nBut no one was going to fund what was in my brain. Not from someone who could barely articulate a coherent thesis to a room full of MBAs.",
    metadata: { layout: 'center' },
  },
  {
    title: 'The cycle.',
    content: "Every 10 to 14 days, the same pattern.\n\nSee it. Start building. Go go go. Burn out. Pause. Recharge. Repeat.\n\nEach time, analyzing. Projecting. The speed of development was accelerating. The tools were getting closer. But they weren't ready yet.\n\nSouth Africa, 2025. WER1. Tried the CLI tools. Tried the agents. Projected that we were near a tipping point — that dev speed would keep accelerating, then level off. Diminishing returns in inference that would need coherence in the rails.",
    metadata: { layout: 'left' },
  },
  {
    title: 'Then the gloves came off.',
    content: "35 days ago, I knew we were going to hit it.\n\nI installed OpenClaw. The constraints broke.\n\nNot \"AI wrote my code.\" The interface layer between what I *see* and working systems finally existed.\n\n30 years of vision. 30 essays already in my head. Hold my beer.",
    metadata: { layout: 'center' },
  },

  // --- ACT 2: THE BUILD ---
  {
    title: 'So I built a light.',
    content: "512 LEDs. An 8×8×8 cube. An AI presence that expresses through color and motion, not text.\n\nComputers became invisible. Invisible became unaccountable.\n\nWhat if you could *see* it thinking?",
    metadata: {
      layout: 'left',
      subtitle: 'Day 1',
    },
  },
  {
    title: 'Then I needed a login.',
    content: "Not email and password. Not OAuth. Not \"Sign in with Google.\"\n\nEd25519 keypair → DID. That's it.\n\nSame primitive for humans and agents. If you can hold a key, you have an identity. No one else involved.",
    metadata: {
      layout: 'left',
      subtitle: 'Day 3',
    },
  },
  {
    title: 'Then I needed to take a payment.',
    content: "Same afternoon. Not \"how do we monetize.\" Just plumbing.\n\nIf identity is a keypair, then a transaction is a signed message between two keypairs.\n\nStripe for fiat. Solana for crypto. Same interface, different rails.",
    metadata: {
      layout: 'left',
      subtitle: 'Still Day 3',
    },
  },
  {
    title: 'Then I needed a phone book.',
    content: "If anyone can have an identity, anyone can run a node.\n\nFederated, not decentralized. Honest about the tradeoff. Central registry now. On-chain later. Mesh trust eventually.\n\nThe exit door is always open.",
    metadata: {
      layout: 'left',
      subtitle: 'Day 4',
    },
  },
  {
    title: 'Then someone bought a ticket.',
    content: "events.imajin.ai → pay.imajin.ai → Stripe → webhook → ticket created.\n\nIdentity → payment → attribution → ticket. All DID-scoped.\n\nThe whole thesis, working as code. Day 7.",
    metadata: { layout: 'center' },
  },
  {
    title: 'Then the server came home.',
    content: "HP ProLiant in my house. Caddy. PM2. Local Postgres.\n\nThe platform was no longer on someone else's servers. It was on hardware I own, behind a domain I control.\n\nSelf-hosted stopped being a feature and became real.",
    metadata: {
      layout: 'left',
      subtitle: 'Day 14',
    },
  },
  {
    title: 'Then I made it invite-only.',
    content: "No public signup. You need an invite code.\n\nThe invite IS the trust boundary.\n\nBuying a ticket? The ticket IS the invite. The transaction creates the trust relationship.\n\nMy AI was Account #1. I accepted its genesis invite to become Account #2.",
    metadata: {
      layout: 'left',
      subtitle: 'Day 16',
    },
  },
  {
    title: 'Then strangers started contributing.',
    content: "A Staff Engineer at Slack opened PRs on day 20.\n\nThe codebase was legible enough for a stranger to contribute to. In 20 days.\n\n7 features shipped in 90 minutes on day 23 using parallel coding agents. 4,800 lines.",
    metadata: {
      layout: 'left',
      subtitle: 'Days 20–23',
    },
  },
  {
    title: 'Then someone who isn\'t a developer used it.',
    content: "Created a real event. 6 ticket tiers. Survey gating. E-Transfer payments.\n\nThe platform was being *used*, not just built.\n\nDay 25.",
    metadata: { layout: 'center' },
  },

  // --- ACT 3: THE REVEAL ---
  {
    title: 'I didn\'t realize what I\'d built.',
    content: "That's not true. I always knew.\n\nBut the *shape* surprised me.\n\nI built from the human angle — auth, pay, connect, share. And the agent layer was always implicit. Hiding inside the trust boundaries I built for people.\n\nIdentity + trust graph + inference = sovereign agent gateway.\n\nThe trust boundaries that protect people are the same boundaries that make agent actions safe.",
    metadata: { layout: 'center' },
  },
  {
    title: 'The choices that seemed practical.',
    content: "In sequence, they reveal something else.",
    metadata: {
      layout: 'left',
      items: [
        'Identity first — who are you, without trusting anyone else?',
        'Payments as plumbing — the ability to transact is as fundamental as the ability to identify.',
        'Trust as topology — connections aren\'t social. They\'re structural.',
        'Attribution as memory — every interaction has provenance.',
        'Hardware as anchor — presence devices can\'t phone home to someone else\'s cloud.',
      ],
    },
  },

  // --- ACT 4: THE NUMBERS ---
  {
    title: '14 services. 35 days. $1,589 in inference.',
    content: "Traditional estimate: $932,316 over 16.4 months with a 3-person team.\n\n190 human hours. 68,024 lines of code. 30 essays. 9 published.\n\nAll open source. All self-hosted. All trust-gated.",
    metadata: {
      layout: 'left',
      items: [
        'auth · pay · profile · registry · connections',
        'events · chat · media · input · learn',
        'coffee · links · dykil · www',
      ],
    },
  },
  {
    title: 'This presentation is running on it.',
    content: "learn.imajin.ai. One of the 14 services.\n\nSeeded from a markdown file I wrote this morning. Rendered by a slide system built this afternoon.\n\nOn my server. On my hardware. On my domain.\n\nThe demo is the infrastructure.",
    metadata: { layout: 'center' },
  },

  // --- ACT 5: THE THESIS ---
  {
    title: 'Start from the human.',
    content: "Everyone in this room is building agents to operate better within platforms.\n\nI spent 30 years being gated by platforms. So I built the exit.\n\nSame keypairs for humans and agents. Same trust graph. Every interaction typed — you always know who you're talking to.\n\nThe agent layer doesn't need its own architecture. It emerges from proper trust boundaries.",
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
    description: '30 years of constrained vision. 35 days of execution. How building for humans first created a sovereign agent gateway.',
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
