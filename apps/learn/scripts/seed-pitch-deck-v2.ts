/**
 * Seed script: Imajin Pitch Deck v2 — $1M raise
 *
 * Protocol-layer infrastructure pitch. Not fintech. Not SaaS.
 * Trust infrastructure for the post-platform internet.
 *
 * Usage: DATABASE_URL="..." npx tsx scripts/seed-pitch-deck-v2.ts
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
  // --- SLIDE 1: FOUNDER ---
  {
    title: 'Ryan Veteze',
    content: "30 years building systems. Director-level, led 8 teams. Built a dance music network that's been running for 25 years.\n\nI've been trying to build what I'm about to show you for my entire career. Capital-gated every time. The architecture was always in my head — no one was going to fund it from someone who couldn't articulate it in VC-speak.\n\nThen AI collapsed the execution barrier. I had 30 years of architectural clarity loaded and ready.\n\n35 days. $1,589 in inference costs. 14 live services. 68,000 lines of code.\n\nThis isn't a pitch for something I'm going to build. It's already built.",
    metadata: { layout: 'left', subtitle: 'he/they · Founder, Imajin' },
  },

  // --- SLIDE 2: THE PROBLEM ---
  {
    title: 'Platform capture is the problem.',
    content: "Not fees. Not UX. Not any single product failure.\n\nThe architecture itself. Every major platform holds four things hostage:",
    metadata: {
      layout: 'left',
      items: [
        'Identity — your existence online is an account on someone else\'s server. They can revoke it.',
        'Reputation — your Uber rating, your Airbnb stars, your Yelp reviews. None of it comes with you when you leave.',
        'Relationships — your social graph is the platform\'s asset, not yours. That\'s the lock-in.',
        'Revenue — 30% app store cuts. 3% payment processing. 15-45% marketplace takes. Every transaction funds your captor.',
      ],
    },
  },
  {
    title: 'This isn\'t a consumer complaint. It\'s a structural problem.',
    content: "3.2 billion people use platforms that monetize their identity without their consent.\n\n$600B+ flows through payment processors who add zero value beyond moving numbers between databases.\n\nThe emerging agent economy has no trust infrastructure at all — agents operate on platforms with no identity, no attribution, no accountability.\n\nEvery AI company is building agents to operate better *within* these captured systems. Nobody is building the exit.",
    metadata: { layout: 'left' },
  },

  // --- SLIDE 3: THE INSIGHT ---
  {
    title: 'What if identity, payments, trust, and attribution were one layer?',
    content: "Not four products. One protocol.\n\nEvery person and every agent holds the same keypair. Every transaction is signed. Every interaction is attributed. Trust is topology, not algorithm.\n\nThe pieces exist in isolation — DIDs, crypto rails, reputation systems, attribution standards. We connected them into a single sovereign stack.",
    metadata: { layout: 'center' },
  },

  // --- SLIDE 4: WHAT WE BUILT ---
  {
    title: '14 services. All live. All open source.',
    content: "Not a whitepaper. Working infrastructure with real users.",
    metadata: {
      layout: 'left',
      subtitle: 'Built in 35 days · Self-hosted on owned hardware',
      items: [
        'auth — Ed25519 keypair identity (humans + agents)',
        'pay — settlement engine (Stripe + Solana)',
        'connections — trust graph with invite-only onboarding',
        'events — ticketed events with trust-gated access',
        'chat — real-time messaging with WebSocket',
        'media — DID-pegged storage with .fair attribution',
        'learn — courses, presentations, education settlement',
        'registry — federated node discovery',
        'profile · coffee · links · dykil · input · www',
      ],
    },
  },

  // --- SLIDE 5: HOW IT WORKS ---
  {
    title: 'The trust-gated service layer.',
    content: "Every service interaction is scoped by identity and trust.\n\nA ticket purchase creates a trust relationship. An invite extends your graph. A query routes through trust topology. No algorithms decide who sees what — the trust graph does.\n\nSame primitives for humans and agents. Every actor is typed and signed. No impersonation by design.",
    metadata: {
      layout: 'left',
      table: {
        headers: ['Layer', 'Function'],
        rows: [
          ['Identity', 'Ed25519 keypairs → DIDs. You generate it. No one issues it.'],
          ['Commerce', 'Signed transactions. Stripe for fiat, Solana for crypto.'],
          ['Trust', 'Invite-only graph. Connections are structural, not social.'],
          ['Attribution', '.fair manifests on everything. Provenance by default.'],
          ['Presence', 'Physical hardware anchors. You can see the node is there.'],
        ],
      },
    },
  },

  // --- SLIDE 6: NODE MODEL ---
  {
    title: 'Not everyone runs a server.',
    content: "A single node can host hundreds or thousands of users. The hardware is the interface to the node you trust.",
    metadata: {
      layout: 'left',
      items: [
        'Tier 1: Use someone else\'s node — trust your operator, data always portable. Free.',
        'Tier 2: Run your own node — Raspberry Pi, ~$50. Full sovereignty.',
        'Tier 3: Run a community node — server + Unit hardware. Serve your community. Earn from every settlement.',
      ],
    },
  },
  {
    title: 'The BBS model, rebuilt.',
    content: "A venue owner runs a community node. Unit in the lobby — 512 LEDs making the AI presence visible. Hundreds of people transacting through it.\n\nNobody in that community touches hardware. They trust the operator. If the operator betrays trust, they take their DID and walk.\n\nYou couldn't take your BBS posts with you in 1991. Now you can.",
    metadata: { layout: 'center' },
  },

  // --- SLIDE 7: BUSINESS MODEL ---
  {
    title: 'Five revenue streams. Revenue from day one.',
    content: "No critical mass required. Every stream produces income from the first transaction.",
    metadata: {
      layout: 'left',
      items: [
        'Settlement fees — protocol percentage on every transaction that flows through the network.',
        'Sovereign advertising — users build their own ad profiles. Declared intent, not surveillance. User earns from their own attention.',
        'Headless service settlement — machine-to-machine. Every API call between nodes is a revenue event. This is where the agent economy lives.',
        'Education settlement — direct knowledge transactions. Courses, tutorials, consultations. Attribution chains compensate upstream.',
        'Trust graph queries — "Ask [Name]." Domain expertise as queryable infrastructure. The revenue stream with no ceiling.',
      ],
    },
  },
  {
    title: 'Depth over reach.',
    content: "500 engaged people transacting daily is worth more than 50,000 passive scrollers.\n\nThe trust graph compounds — the longer someone participates, the more valuable their node becomes. Not from data extraction. From genuine, attributed, settled interactions.\n\nAll five streams settle through .fair. Unified attribution. Transparent splits. No black-box algorithms deciding who gets paid.",
    metadata: { layout: 'center' },
  },

  // --- SLIDE 8: MARKET ---
  {
    title: 'Two markets converging.',
    content: "**Captured reputation** — every industry where your history doesn't follow you.\n\n**Agent infrastructure** — the emerging AI agent economy has no trust layer.",
    metadata: {
      layout: 'left',
      items: [
        'Local commerce — 33M US small businesses, ~$15K/year each in payment processing fees.',
        'Hospitality — 7M+ Airbnb listings with non-portable ratings.',
        'Freelancing — $1.5T market, zero portable reputation.',
        'AI agents — $B+ in agent infrastructure investment, no identity or trust standard.',
      ],
    },
  },
  {
    title: 'The agent opportunity.',
    content: "Every AI company is building agents to operate within platforms. Nobody is building the trust infrastructure agents need to operate *between* platforms — or outside them entirely.\n\nImajin is that infrastructure. Same keypairs. Same DIDs. Same trust graph. The agent layer doesn't need its own architecture. It emerges from proper trust boundaries.\n\nWe're not competing with agent frameworks. We're the substrate they're missing.",
    metadata: { layout: 'center' },
  },

  // --- SLIDE 9: TRACTION ---
  {
    title: 'Where we are.',
    content: "35 days in. This is not a concept.",
    metadata: {
      layout: 'left',
      items: [
        '14 live services, self-hosted on owned hardware',
        '~60 registered identities on the trust graph',
        'Real events with real ticket sales (Stripe + e-Transfer)',
        'External contributors (first PR from a Staff Engineer at Slack)',
        '30 essays — 9 published (the complete intellectual foundation)',
        'MJN token reserved on Solana mainnet (0 supply, ready for Phase 2)',
        'GPU node running local inference (RTX 3080 Ti)',
        'GitHub Actions CI/CD on self-hosted runner',
      ],
    },
  },
  {
    title: 'The cost story.',
    content: "Traditional estimate for what exists: **$932,316** over 16.4 months with a 3-person team.\n\nActual: **$1,589** in API costs. 190 human hours. 35 days.\n\nThis isn't just an AI-augmented build. This is what happens when 30 years of architectural clarity meets tools that can finally execute at the speed of thought.",
    metadata: {
      layout: 'center',
    },
  },

  // --- SLIDE 10: GO TO MARKET ---
  {
    title: 'Community nodes, not app downloads.',
    content: "The go-to-market is physical. One venue, one community, one node at a time.",
    metadata: {
      layout: 'left',
      items: [
        'Phase 1 — Prove the loop. 10 community nodes in Toronto. Venues, studios, practices. Real transactions, real settlements, real trust graph density.',
        'Phase 2 — City clusters. Node operators recruit each other. Communities expect the infrastructure. Events as mass onboarding.',
        'Phase 3 — Protocol API. Imajin becomes the identity and trust layer underneath. The infrastructure play.',
      ],
    },
  },

  // --- SLIDE 11: COMPETITIVE LANDSCAPE ---
  {
    title: 'Everyone built pieces.',
    content: "Nobody connected them.",
    metadata: {
      layout: 'left',
      items: [
        'Auth0, Clerk, Firebase — identity as a service, but you\'re still renting your existence from them.',
        'Stripe, Square — payment rails with no interest in what happens after the transaction.',
        'Dock, Cheqd, Trinsic — credential plumbing for enterprise KYC. Not consumer infrastructure.',
        'Gitcoin, Lens, Farcaster — social reputation. Popularity ≠ reliability.',
        'OpenRouter, LiteLLM — inference routing for developers. No consumer packaging, no sovereignty, no trust.',
      ],
    },
  },
  {
    title: 'Our position.',
    content: "We built all five layers — identity, commerce, trust, attribution, presence — and connected them into a single protocol.\n\nThe settlement is the anchor. Every interaction attributed. Every participant compensated. Every actor accountable.\n\nOpen source. Self-hostable. Federated. No kill switch.",
    metadata: { layout: 'center' },
  },

  // --- SLIDE 12: THE ASK ---
  {
    title: '$1M',
    content: "Not a round. A milestone. First institutional capital into working infrastructure.",
    metadata: {
      layout: 'left',
      stats: [
        { label: 'Community nodes — 10 Toronto deployments', value: '35%' },
        { label: 'Protocol development — federation, on-chain registry, agent gateway', value: '30%' },
        { label: 'Team — first hires (community, engineering)', value: '25%' },
        { label: 'Runway — founder + infrastructure', value: '10%' },
      ],
    },
  },
  {
    title: 'Milestones.',
    content: "What $1M buys in 12 months:",
    metadata: {
      layout: 'left',
      items: [
        '10 community nodes live in Toronto with real daily transaction volume.',
        'Federation between sovereign nodes — your data moves with you.',
        'Agent gateway — trust-gated inference routing as a service.',
        'First protocol revenue — settlement fees flowing from real transactions.',
        '1,000+ identities on the trust graph with organic growth.',
        'On-chain registry on Solana — decentralized node discovery.',
      ],
    },
  },

  // --- SLIDE 13: THE THESIS ---
  {
    title: 'The thesis.',
    content: "The internet was built to move documents. Then packets. Neither carried the human.\n\nPlatforms filled the gap — and captured everything.\n\nImajin carries the human. Identity, trust, attribution, settlement — all in one protocol. For humans and agents alike.\n\nThe best way to make something better within a system that has absolute control over everything is to make a completely free system that works on its own frequency.",
    metadata: { layout: 'center' },
  },
  {
    title: '',
    content: "30 years of vision. 30 essays. 35 days of execution.\n\n14 services. $1,589. All open source.\n\nThe exit infrastructure is built. Now we scale it.",
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

  await sql`CREATE SCHEMA IF NOT EXISTS learn`;

  const courseId = generateId('crs');
  const moduleId = generateId('mod');

  console.log('\nSeeding: Imajin Pitch Deck v2...');

  await db.insert(courses).values({
    id: courseId,
    creatorDid: CREATOR_DID,
    title: 'Imajin — Pitch Deck',
    description: 'Trust infrastructure for the post-platform internet. 30 years of vision. 35 days of execution.',
    slug: 'imajin-pitch',
    price: 0,
    currency: 'CAD',
    visibility: 'public',
    tags: ['pitch', 'presentation', 'investor'],
    status: 'published',
    metadata: {},
  });

  console.log(`  Course: ${courseId} (imajin-pitch)`);

  await db.insert(modules).values({
    id: moduleId,
    courseId,
    title: 'Pitch Deck',
    description: '$1M raise — protocol-layer infrastructure',
    sortOrder: 0,
  });

  console.log(`  Module: ${moduleId} (Pitch Deck) — ${slides.length} slides`);

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
  console.log(`   imajin-pitch — ${slides.length} slides`);
  console.log(`\n   Present: learn.imajin.ai/course/imajin-pitch/present`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
