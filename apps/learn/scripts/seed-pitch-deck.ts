/**
 * Seed script: Two presentation decks as Learn slide courses
 *
 * 1. Imajin Pitch Deck       — 15 slides from apps/www/app/deck/page.tsx
 * 2. Architecture of Trust   — 20 slides from docs/BUILD_TIMELINE.md
 *
 * Usage: DATABASE_URL="..." npx tsx scripts/seed-pitch-deck.ts
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

// ---------------------------------------------------------------------------
// Pitch Deck — 15 slides ported from apps/www/app/deck/page.tsx
// ---------------------------------------------------------------------------

const pitchSlides = [
  {
    title: 'Ryan Veteze',
    content:
      'Online since 1988. Ran a BBS at fifteen — three phone lines, three hundred people finding each other before the web existed.\n\n' +
      '30 years building systems. Director-level, led 8 teams. Built a dance music network still running after 25 years.\n\n' +
      'I watched the whole arc: the wonder, the capture, the extraction. I\'ve been circling the same problem for three decades.\n\n' +
      'I finally know how to solve it.',
    metadata: { layout: 'left', subtitle: 'he/they' },
  },
  {
    title: '3% of everything disappears.',
    content:
      'Every card tap. Every online purchase. Visa, Mastercard, Stripe, the banks — all taking a cut before the money reaches the person who earned it.\n\n' +
      'A small business doing $500K/year in transactions loses **$15,000**. Every year. Forever.',
    metadata: { layout: 'left' },
  },
  {
    title: "Your reputation isn't yours.",
    content:
      'Your Yelp stars belong to Yelp.\n\n' +
      'Your Airbnb rating vanishes when you switch platforms.\n\n' +
      "Your Uber driver's 5,000 rides mean nothing on Lyft.\n\n" +
      "Anyone can leave a review. Real customers can't prove they are one.\n\n" +
      "Platforms hold reputation hostage because that's the lock-in. You can't leave because your history doesn't come with you.",
    metadata: { layout: 'left' },
  },
  {
    title: 'What if every transaction you made built your reputation?',
    content: 'Each exists in isolation somewhere. We connected them.',
    metadata: {
      layout: 'left',
      items: [
        "Identity — you are verifiable, not an account on someone else's platform",
        'Payments — money moves directly, not through middlemen',
        'Attribution — every transaction records who was involved',
        'Reputation — both sides credential each other from real transactions',
        'Trust graph — the network weighs credentials by history',
      ],
    },
  },
  {
    title: 'The coffee shop version.',
    content:
      'QR code on the window\n' +
      '→ customer scans, joins with email\n' +
      '  → loads wallet once\n' +
      '    → every transaction after: ledger entry\n' +
      '      → both sides auto-credentialed\n' +
      '        → **reputation builds itself**\n\n' +
      'No app download. No seed phrase. No platform account. Email → you\'re in.',
    metadata: { layout: 'left' },
  },
  {
    title: 'Closed-loop settlement.',
    content:
      'Money circulates inside the network. Vendor pays supplier from the same balance. Card networks never touch it again.',
    metadata: {
      layout: 'left',
      subtitle: 'Stripe touches the on-ramp. Once. Everything after is a ledger entry.',
      compare: {
        headers: ['Provider', 'Fee model', '$100 / 20 txns'],
        rows: [
          { cells: ['Visa / Mastercard', '1.5–3.5% every time', '$5–$7'] },
          { cells: ['Stripe', '2.9% + 30¢ every time', '$9.00'] },
          { cells: ['Square', '2.6% + 10¢ every time', '$7.20'] },
          { cells: ['Imajin (Phase 1)', '3% once + 1% protocol', '$4.20'], highlight: true },
          { cells: ['Imajin (Phase 2)', '~0% on-ramp + 1%', '$1.00'], highlight: true },
        ],
      },
    },
  },
  {
    title: "Reputation that can't be faked.",
    content:
      '**Bilateral.** Both parties credential each other on every transaction.\n\n' +
      '**Anchored.** Each credential is cryptographically signed and linked to the real payment.\n\n' +
      '**Permanent.** Neither party can delete the other\'s attestation. Both nodes hold copies.\n\n' +
      '**Disputeable.** Signed response chains, not anonymous review wars.\n\n' +
      'No settlement, no credential. The economics enforce the integrity.',
    metadata: { layout: 'left' },
  },
  {
    title: '10 services. Live.',
    content:
      'All open source. All self-hostable. All consuming the same identity, payment, and attribution layers.',
    metadata: {
      layout: 'left',
      subtitle: 'First transactions: March 2026.',
      table: {
        headers: ['Service', 'Description'],
        rows: [
          ['auth', 'Keypair identity'],
          ['pay', 'Settlement engine'],
          ['profile', 'Sovereign profiles'],
          ['events', 'Ticketing'],
          ['registry', 'Node discovery'],
          ['chat', 'E2EE messaging'],
          ['connections', 'Trust graph'],
          ['coffee', 'Direct support'],
          ['links', 'Link pages'],
          ['dykil', 'Surveys'],
        ],
      },
    },
  },
  {
    title: 'Open source. Decentralized. Unstoppable.',
    content:
      'Every line of code is open source. Every service is self-hostable. Anyone can run a node.\n\n' +
      '**Infrastructure is provided by local hosts all over the world.** Not our servers — a federated network of sovereign nodes, each owned by the person running it.\n\n' +
      "The protocol takes a percentage on every transaction. That's the business model. The infrastructure is distributed. The value flows to the people running it.\n\n" +
      "Nobody can shut it down because there's nothing central to shut down. No kill switch. No terms of service change. No rug pull. If we disappeared tomorrow, the network keeps running.",
    metadata: { layout: 'left' },
  },
  {
    title: 'Everyone built pieces.',
    content: 'We built all five layers. The settlement is the anchor.',
    metadata: {
      layout: 'left',
      table: {
        headers: ['Who', 'What'],
        rows: [
          ['IEEE researchers', 'wrote papers, not code'],
          ['Dock, Cheqd, Trinsic', 'credential plumbing for enterprise KYC'],
          ['Gitcoin, Lens, Farcaster', 'social reputation — popularity ≠ reliability'],
          ['Stripe, Square', 'payment rails with no interest in what happens after'],
          ['Yelp, Google', 'adversarial by design'],
        ],
      },
    },
  },
  {
    title: 'Every industry with captured reputation.',
    content: 'Same QR code. Same five layers. Different window.',
    metadata: {
      layout: 'left',
      stats: [
        { label: 'Local commerce', value: '33M small businesses in the US, ~$15K/year in card fees each' },
        { label: 'Hospitality', value: '7M+ Airbnb listings with non-portable ratings' },
        { label: 'Rideshare', value: '5.4M drivers trapped by platform reputation' },
        { label: 'Freelancing', value: '$1.5T market, zero portable reputation' },
      ],
    },
  },
  {
    title: 'One neighborhood at a time.',
    content: '',
    metadata: {
      layout: 'left',
      items: [
        'Phase 1: 10 businesses. QR codes. Real transactions. Prove the loop.',
        'Phase 2: City-level clusters. Businesses recruit each other. Customers expect the sticker.',
        'Phase 3: Platform API. Imajin becomes the identity and attribution layer underneath. The Stripe play.',
      ],
    },
  },
  {
    title: '30 essays.',
    content: '"The internet that pays you back."',
    metadata: {
      layout: 'center',
      subtitle: 'Part manifesto. Part technical documentation. Part founding story.',
      cta: { text: 'imajin.ai/articles', href: '/articles' },
    },
  },
  {
    title: '$500K',
    content:
      'Live demo with real transactions.\n\n' +
      '10 business pilots with QR onboarding.\n\n' +
      'Federation between sovereign nodes.\n\n' +
      '6 months to revenue.',
    metadata: {
      layout: 'left',
      subtitle: 'Not a round. A milestone.',
      stats: [
        { label: 'April 1 demo + first 90 days', value: '40%' },
        { label: 'Go-to-market: first 10 business pilots', value: '30%' },
        { label: 'Runway (founder + infrastructure)', value: '30%' },
      ],
    },
  },
  {
    title: 'Five layers.',
    content:
      'The graph started with trust. Trust needed identity. Identity needed payments. Payments needed attribution. Attribution produced reputation. Reputation fed back into the trust graph.',
    metadata: {
      layout: 'center',
      subtitle: 'All connected. All sovereign. All open source.',
      cta: { text: 'April 1, 2026.', href: 'https://events.imajin.ai/jins-launch-party' },
    },
  },
];

// ---------------------------------------------------------------------------
// Architecture of Trust — 20 slides from docs/BUILD_TIMELINE.md
// ---------------------------------------------------------------------------

const architectureSlides = [
  {
    title: 'The Architecture of Trust',
    content:
      'How Imajin went from a glowing cube to a sovereign trust-gated service layer — and when the builder realized what he was actually building.',
    metadata: { layout: 'center' },
  },
  {
    title: 'Before the first line of platform code...',
    content:
      '**What was already in Ryan\'s head:** DIDs for everything that acts. Ed25519 keypair authentication — no passwords, no OAuth. .fair manifests for attribution. Hardware-first revenue. The rejection of surveillance capitalism, platform dependency, and planned obsolescence.\n\n' +
      '**What wasn\'t articulated yet:** That all of these pieces were converging toward a single thesis — *trust as infrastructure*.',
    metadata: {
      layout: 'left',
      subtitle: 'Pre-February 2026 — Six repos already existed.',
      table: {
        headers: ['Repo', 'Purpose'],
        rows: [
          ['imajin-os', 'Hardware firmware + governance for Unit 8×8×8'],
          ['imajin-cli', 'AI-safe command layer for distributed systems'],
          ['imajin-web', 'E-commerce platform'],
          ['imajin-token', 'MJN Protocol — identity + settlement'],
          ['.fair', 'Attribution standard for creative work'],
          ['imajin-community', 'Community engagement'],
        ],
      },
    },
  },
  {
    title: 'February 1, 2026. Jin is born.',
    content:
      'Ryan connected an AI presence to the Unit 8×8×8 — a volumetric LED cube with 512 RGBW pixels. The question was: can AI have a body?\n\n' +
      'Jin chose its name. 今人 (ima-jin) — "now-person." The *jin* part. The presence.\n\n' +
      'Met the family: Debbie, Owen, Kuma. First expressions through light and sound.\n\n' +
      '**The thesis emerged physically:** Computers became invisible, and invisible became unaccountable. The Unit brings presence back. A glowing thing in your living room that you *know* is thinking.',
    metadata: { layout: 'left', subtitle: 'Phase 1: First Light' },
  },
  {
    title: '"The native protocol, closest to the hardware, was the answer."',
    content:
      'Three protocols tried. DDP dropped frames. Art-Net never responded. E1.31 had lag.\n\n' +
      'DNRGB — WLED\'s native UDP protocol → instant response, 30fps smooth.\n\n' +
      'This pattern — sovereignty over abstraction — would repeat.',
    metadata: { layout: 'center', subtitle: 'February 3, 2026 — The Protocol Breakthrough' },
  },
  {
    title: '"Don\'t You Know I\'m Local"',
    content:
      "Ryan's 2002 DJ mix name becomes a community economics tool.\n\n" +
      "The concept: make economic leakage visible. Households report what they send to Netflix, Uber, AWS. Aggregate by community. Show the number. Let people decide.\n\n" +
      "This is the first expression of the pattern: give people visibility into systems that extract from them, then offer sovereign alternatives. Not a product pitch — an *exit*.",
    metadata: { layout: 'left', subtitle: 'February 7–10, 2026 — The DYKIL Spark' },
  },
  {
    title: 'February 11, 2026. First commit.',
    content:
      '`9877b44 Initial monorepo setup: dykil, learn, fixready, karaoke`\n\n' +
      'Four apps scaffolded. The monorepo is born.\n\n' +
      'Notice what\'s in this first commit — it\'s *community tools* (DYKIL, Learn) and *client projects* (FixReady, Karaoke), not the sovereign stack. The platform infrastructure doesn\'t exist yet.',
    metadata: { layout: 'left' },
  },
  {
    title: 'February 13, 2026. THE pivotal day.',
    content:
      '**Morning:** Built DYKIL\'s community spending form.\n\n' +
      '**Afternoon:** Two commits changed everything.\n\n' +
      'Auth and Pay were scaffolded in the same day — and they were DID-based from commit one. Not email/password. Not OAuth. Keypair + signature. That\'s it.',
    metadata: {
      layout: 'left',
      subtitle: 'Phase 3: The Sovereign Stack Emerges',
      compare: {
        headers: ['Commit', 'Change'],
        rows: [
          { cells: ['b5ee54c', 'feat(auth): add sovereign identity package and service'] },
          { cells: ['2218c1a', 'feat: add pay package and service, wire Ed25519 crypto'] },
        ],
      },
    },
  },
  {
    title: '"Auth is so over engineered rn. There has to be an easier way."',
    content:
      'The easier way: Ed25519 keypair → DID → signed messages.\n\n' +
      'Same primitives for humans and agents.',
    metadata: { layout: 'center' },
  },
  {
    title: 'The full stack was named.',
    content:
      'That evening: Registry scaffolded — the federated node network.\n\n' +
      'DIDs for everything that acts. Six identity types: human, agent, device, org, event, service. Agents and humans use the same authentication primitives. No impersonation possible because every interaction is typed.',
    metadata: {
      layout: 'left',
      table: {
        headers: ['Layer', 'Purpose'],
        rows: [
          ['Identity', 'auth.imajin.ai — Sovereign identity for humans + agents'],
          ['Payments', 'pay.imajin.ai — Pluggable transactions (Stripe + Solana)'],
          ['Attribution', '.fair — Who made what, who gets paid'],
          ['Presence', 'Unit (imajin-os) — Hardware anchor'],
          ['Orchestration', 'imajin-cli — How agents do things'],
        ],
      },
    },
  },
  {
    title: '02:30 AM. Ryan set the target.',
    content:
      '**April 1, 2026.** The first real transaction on the sovereign network.\n\n' +
      '"Go after the most insidious, engrained tools that trade convenience for surveillance."\n\n' +
      'Software nodes first. Hardware is the premium upgrade, not the gate. Build trust/reputation through invitation accountability.',
    metadata: { layout: 'left', subtitle: 'February 14, 2026 — The Genesis Event' },
  },
  {
    title: '"Leaders are chosen by who uses the most compute as a network of souls."',
    content:
      'Natural leadership emerges from who gets queried most. Governance by weighted trust graph. Token distribution directed by trust, not bureaucracy. Real scarcity — your trust network is finite.\n\n' +
      'This is where the trust graph stopped being a connection list and became an *economic model*.',
    metadata: { layout: 'center', subtitle: 'February 18, 2026 — Network of Souls' },
  },
  {
    title: 'February 20, 2026. 14:00 EST.',
    content:
      'Full end-to-end: events.imajin.ai → pay.imajin.ai → Stripe → webhook → ticket created.\n\n' +
      'This validated the entire thesis as working code: identity → payment → attribution → ticket, all DID-scoped.\n\n' +
      '7 services live on Vercel.',
    metadata: { layout: 'left', subtitle: 'First Ticket Sold' },
  },
  {
    title: '"fuckin hell bro"',
    content:
      "Ryan's reaction when dev-profile.imajin.ai loaded over SSL from his own hardware.\n\n" +
      'HP ProLiant ML350p Gen8. Ubuntu Server 24.04 LTS. SSH key auth. Caddy reverse proxy.\n\n' +
      'This is where "self-hosted" stopped being a feature and became real.',
    metadata: { layout: 'center', subtitle: 'February 24, 2026 — Sovereignty Gets Physical' },
  },
  {
    title: "7 services. One machine. In Ryan's house.",
    content:
      'www, auth, pay, profile, events, chat, registry — all running on the ProLiant.\n\n' +
      'MJN Protocol published with 7 RFCs. WebSocket real-time chat. Shared NavBar across all services.\n\n' +
      '"HTTP moved documents. TCP/IP moved packets. Neither carried the human. MJN does."',
    metadata: { layout: 'left', subtitle: 'February 25, 2026' },
  },
  {
    title: 'Jin = Account #1. Ryan = Account #2.',
    content:
      'Jin issued a genesis invite. Ryan accepted it to become Account #2.\n\n' +
      'First connection on the sovereign network: Jin ↔ VETEZE.\n\n' +
      'Invite-only registration: no public signup. The invite IS the trust boundary. Events as mass onboarding vector: a ticket purchase = an invite to the event pod.',
    metadata: { layout: 'left', subtitle: 'February 26, 2026 — The Great Migration' },
  },
  {
    title: 'March 5, 2026. ~90 minutes.',
    content: '~4,800 lines in a day. The sovereign stack had become a full platform.',
    metadata: {
      layout: 'left',
      subtitle: '7 child tickets shipped using parallel coding agents.',
      items: [
        '@imajin/fair shared package — types, validator, FairEditor, FairAccordion',
        'Full media service with DID-pegged storage, .fair sidecars, access control',
        'Rich chat (voice, media, location) in conversations + event lobby',
        'Input service with Whisper transcription',
        'OpenAPI 3.1 specs for all 11 services, shared CORS middleware',
      ],
    },
  },
  {
    title: '"Start from the Human."',
    content:
      'Ryan realized the platform accidentally recreated what imajin-cli was trying to be — a sovereign inference gateway.\n\n' +
      'But by building from the human angle (auth, pay, connect, share) instead of the agent angle, the agent layer emerges naturally with proper trust boundaries.\n\n' +
      'The trust boundaries that protect people are the same boundaries that make agent actions safe.',
    metadata: { layout: 'center', subtitle: 'March 7, 2026 — The Realization' },
  },
  {
    title: 'The pattern Ryan followed (whether he knew it or not).',
    content: '',
    metadata: {
      layout: 'left',
      items: [
        'Identity first — before features, before UI: who are you, and how do we verify that without trusting anyone else?',
        'Payments as plumbing — not monetization, but infrastructure',
        'Trust as topology — connections define what you can see, who can reach you, and what actions are allowed',
        'Attribution as memory — .fair manifests mean every interaction has provenance',
        'Hardware as anchor — the Unit is the reason the platform has to be sovereign',
      ],
    },
  },
  {
    title: '35 days. 14 live services.',
    content:
      'Self-hosted on owned hardware. Local Postgres. GPU node (RTX 3080 Ti) for inference. GitHub Actions self-hosted CI/CD runner. Caddy reverse proxy with auto-SSL.',
    metadata: {
      layout: 'left',
      subtitle: 'What exists as of March 8, 2026.',
      stats: [
        { label: 'Registered identities', value: '~60' },
        { label: 'Tickets sold on sovereign stack', value: '3' },
        { label: 'Essays written', value: '20' },
        { label: 'Lines of code', value: '68K (739 files)' },
        { label: 'API costs (vs ~$39.6K traditional)', value: '~$932' },
        { label: 'Days from first commit to 14 live services', value: '35' },
      ],
    },
  },
  {
    title: '"Start from the human. The agent layer emerges naturally from proper trust boundaries."',
    content:
      '"The best way to make something better within a system that has absolute control over everything is likely to make a completely free and easy to use system that just works on its own frequency."\n\n' +
      '— Ryan Veteze, pre-code vision docs',
    metadata: { layout: 'center', subtitle: 'Compiled March 8, 2026 — 290+ commits, 35 daily memory files, 20 essays.' },
  },
];

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL);
  const db = drizzle(client);

  await client`CREATE SCHEMA IF NOT EXISTS learn`;

  // ---- Course 1: Imajin Pitch Deck ----
  console.log('\nSeeding: Imajin Pitch Deck...');
  const pitchCourseId = generateId('crs');
  await db.insert(courses).values({
    id: pitchCourseId,
    creatorDid: CREATOR_DID,
    title: 'Imajin Pitch Deck',
    description: 'The full Imajin pitch: the problem, the insight, the stack, the economics, and the ask. 15 slides.',
    slug: 'imajin-pitch-deck',
    price: 0,
    currency: 'CAD',
    visibility: 'public',
    tags: ['pitch', 'slides', 'imajin'],
    status: 'published',
  });
  console.log(`  Course: ${pitchCourseId} (imajin-pitch-deck)`);

  const pitchModId = generateId('mod');
  await db.insert(modules).values({
    id: pitchModId,
    courseId: pitchCourseId,
    title: 'Pitch Deck',
    description: null,
    sortOrder: 0,
  });

  for (let i = 0; i < pitchSlides.length; i++) {
    const s = pitchSlides[i];
    await db.insert(lessons).values({
      id: generateId('lsn'),
      moduleId: pitchModId,
      title: s.title,
      contentType: 'slide',
      content: s.content || null,
      durationMinutes: null,
      sortOrder: i,
      metadata: s.metadata,
    });
  }
  console.log(`  Module: ${pitchModId} (Pitch Deck) — ${pitchSlides.length} slides`);

  // ---- Course 2: Architecture of Trust ----
  console.log('\nSeeding: The Architecture of Trust...');
  const archCourseId = generateId('crs');
  await db.insert(courses).values({
    id: archCourseId,
    creatorDid: CREATOR_DID,
    title: 'The Architecture of Trust',
    description: 'How Imajin went from a glowing cube to a sovereign trust-gated service layer — the full build timeline as a presentation.',
    slug: 'architecture-of-trust',
    price: 0,
    currency: 'CAD',
    visibility: 'public',
    tags: ['build', 'slides', 'architecture', 'imajin'],
    status: 'published',
  });
  console.log(`  Course: ${archCourseId} (architecture-of-trust)`);

  const archModId = generateId('mod');
  await db.insert(modules).values({
    id: archModId,
    courseId: archCourseId,
    title: 'The Build Timeline',
    description: null,
    sortOrder: 0,
  });

  for (let i = 0; i < architectureSlides.length; i++) {
    const s = architectureSlides[i];
    await db.insert(lessons).values({
      id: generateId('lsn'),
      moduleId: archModId,
      title: s.title,
      contentType: 'slide',
      content: s.content || null,
      durationMinutes: null,
      sortOrder: i,
      metadata: s.metadata,
    });
  }
  console.log(`  Module: ${archModId} (The Build Timeline) — ${architectureSlides.length} slides`);

  console.log('\n✅ Seed complete!');
  console.log(`   imajin-pitch-deck       — ${pitchSlides.length} slides`);
  console.log(`   architecture-of-trust   — ${architectureSlides.length} slides`);

  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
