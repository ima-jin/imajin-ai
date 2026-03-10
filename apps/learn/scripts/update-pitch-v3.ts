/**
 * Update Imajin Pitch Deck to v3 — post-convergence
 * 
 * Updates existing slides and adds new ones for:
 * - Wallet discovery (identity IS settlement)
 * - Typed identity primitives
 * - Token economics
 * - Multi-angle pitch
 * - "Start from the human and you will find the protocol"
 *
 * Usage: DATABASE_URL="..." npx tsx scripts/update-pitch-v3.ts
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { lessons, modules } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';

function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

// Slide IDs from the live DB
const SLIDE_IDS = {
  founder: 'lsn_mmi48egk3095f66d8f834',
  problem1: 'lsn_mmi48egs3292ab7f28774',
  problem2: 'lsn_mmi48eh1d33a5bed84b74',
  insight: 'lsn_mmi48eh91e829f7306ed4',
  services: 'lsn_mmi48ehi864d57778ee04',
  trustLayer: 'lsn_mmi48ehyd132d9a704a24',
  nodeModel: 'lsn_mmi48ei7fddace717c644',
  bbs: 'lsn_mmi48eifaf94981cb8534',
  revenue: 'lsn_mmi48eina13ecde764504',
  depth: 'lsn_mmi48eiv34aa3c80ed274',
  market1: 'lsn_mmi48ej47bc8590c99a34',
  market2: 'lsn_mmi48ejc7122cf7005ce4',
  traction: 'lsn_mmi48ejkc723d0feabbf4',
  costStory: 'lsn_mmi48ejt416ad77711a54',
  goToMarket: 'lsn_mmi48ek12fdb2d4144b24',
  competitive1: 'lsn_mmi48ek979ebf160a58d4',
  competitive2: 'lsn_mmi48eki10e8968bb3344',
  ask: 'lsn_mmi48ekqb315baebc3d24',
  milestones: 'lsn_mmi48ekye90d77143f664',
  thesis: 'lsn_mmi48el72ff5e13ad3934',
  closer: 'lsn_mmi48elf1d8c0d15b3654',
};

// Module ID for new slides
const MODULE_ID_QUERY = `SELECT m.id FROM learn.modules m JOIN learn.courses c ON m.course_id = c.id WHERE c.slug = 'imajin-pitch' LIMIT 1`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url);
  const db = drizzle(sql);

  // Get the module ID
  const [{ id: moduleId }] = await sql.unsafe(MODULE_ID_QUERY);
  console.log(`Module: ${moduleId}\n`);

  // --- UPDATE EXISTING SLIDES ---

  // Slide 0: Founder
  console.log('Updating: Founder slide');
  await db.update(lessons).set({
    content: `30 years building systems. Director-level, led 8 teams. Built a dance music network that's been running for 25 years.

I've been trying to build what I'm about to show you for my entire career. Capital-gated every time. The architecture was always in my head — no one was going to fund it from someone who couldn't articulate it in VC-speak.

Then AI collapsed the execution barrier. I had 30 years of architectural clarity loaded and ready.

37 days. $1,589 in inference costs. 14 live services. 68,000+ lines of code. ~73 identities on a sovereign trust graph.

This isn't a pitch for something I'm going to build. It's already built. And on Day 37, the protocol discovered itself.`,
    metadata: { layout: 'left', subtitle: 'he/they · Founder, Imajin Inc.' },
  }).where(eq(lessons.id, SLIDE_IDS.founder));

  // Slide 3: The Insight — add wallet discovery + typed primitives
  console.log('Updating: Insight slide');
  await db.update(lessons).set({
    content: `Not four products. One protocol.

Every person and every agent holds the same keypair — Ed25519. Every transaction is signed. Every interaction is attributed. Trust is topology, not algorithm.

And here's the part we didn't plan: Solana uses Ed25519. Every identity on our network is already a Solana wallet. The settlement layer was hiding inside the identity layer the whole time.

Four typed identity primitives — Individual, Family, Cultural, Org — each with different governance, trust semantics, and wallet behavior. The same graph, queried from different primitives, yields fundamentally different shapes.

That's not a feature. It's the architecture.`,
  }).where(eq(lessons.id, SLIDE_IDS.insight));

  // Slide 5: Trust layer — add typed primitives table
  console.log('Updating: Trust layer slide');
  await db.update(lessons).set({
    content: `Every service interaction is scoped by identity and trust.

A ticket purchase creates a trust relationship. An invite extends your graph. A query routes through trust topology. No algorithms decide who sees what — the trust graph does.

Four identity primitives, not one. The protocol knows the difference between a person, a family, a community, and a business — and the trust graph behaves differently for each.`,
    metadata: {
      layout: 'left',
      table: {
        headers: ['Layer', 'Function'],
        rows: [
          ['Identity', 'Ed25519 keypairs → DIDs → Solana wallets. You generate it. No one issues it.'],
          ['Commerce', 'Signed transactions. Stripe for fiat, MJN for on-chain. Dual currency.'],
          ['Trust', 'Invite-only graph. Four primitive types: Individual, Family, Cultural, Org.'],
          ['Attribution', '.fair manifests on everything. Revenue splits follow the identity graph.'],
          ['Settlement', 'Reserve-backed MJN token. Fiat bridge. Every identity is a wallet.'],
        ],
      },
    },
  }).where(eq(lessons.id, SLIDE_IDS.trustLayer));

  // Slide 12: Traction — update numbers
  console.log('Updating: Traction slide');
  await db.update(lessons).set({
    content: `37 days in. This is not a concept.`,
    metadata: {
      layout: 'left',
      items: [
        '14 live services, self-hosted on owned hardware',
        '~73 registered identities (~25 hard DIDs, ~48 soft DIDs)',
        'Every hard DID is a latent Solana wallet — discovered, not designed',
        'Real events with real ticket sales (Stripe + e-Transfer)',
        'External contributors (first PR from a Staff Engineer at Slack)',
        '30 essays — 9 published (the complete intellectual foundation)',
        'MJN token reserved on Solana mainnet, reserve-backed economics model',
        'Whitepaper v0.2 — typed identity primitives, token economics',
        'GPU node running local inference (RTX 3080 Ti)',
        '3 RFCs: Embedded Wallet, Token Economics, Cultural DID',
      ],
    },
  }).where(eq(lessons.id, SLIDE_IDS.traction));

  // Slide 13: Cost story — update
  console.log('Updating: Cost story slide');
  await db.update(lessons).set({
    content: `Traditional estimate for what exists: $932,316 over 16.4 months with a 3-person team.

Actual: $1,589 in API costs. 190+ human hours. 37 days.

This isn't just an AI-augmented build. This is what happens when 30 years of architectural clarity meets tools that can finally execute at the speed of thought.

The protocol wasn't designed on a whiteboard. It was discovered in the git history. Each layer emerged from the one before it — identity begat trust, trust begat attribution, attribution begat settlement, and settlement turned out to be identity all along.`,
  }).where(eq(lessons.id, SLIDE_IDS.costStory));

  // Slide 16: Competitive position — add wallet angle
  console.log('Updating: Competitive position slide');
  await db.update(lessons).set({
    content: `We built all five layers — identity, commerce, trust, attribution, presence — and connected them into a single protocol.

Every identity is a wallet. Every wallet is in a trust graph. Every transaction is attributed. Every actor is accountable.

No other Solana project has a social layer. No other social network has a settlement layer. No other identity system has typed primitives. We have all three — and they're the same thing.

Open source. Self-hostable. Federated. No kill switch.`,
  }).where(eq(lessons.id, SLIDE_IDS.competitive2));

  // --- INSERT NEW SLIDES ---
  // We need to shift sort_order for slides after position 13 to make room

  // First, bump all slides from sort_order 14+ up by 3 to make room for new slides
  console.log('\nShifting slides to make room for new ones...');
  await sql.unsafe(`
    UPDATE learn.lessons SET sort_order = sort_order + 3 
    WHERE module_id = '${moduleId}' AND sort_order >= 14
  `);

  // New slide 14: The Convergence (wallet discovery)
  console.log('Inserting: The Convergence');
  await db.insert(lessons).values({
    id: generateId('lsn'),
    moduleId,
    title: 'Day 37: The protocol discovers itself.',
    contentType: 'slide',
    content: `We chose Ed25519 for identity on Day 3 — because it was the right cryptographic primitive for sovereign keypairs.

Solana uses Ed25519 for wallet addresses.

Nobody planned this. We weren't building a crypto product. We were building identity infrastructure. But because both were solving for the same mathematical truth, every registered user was already a Solana wallet holder.

The settlement layer was inside the identity layer the whole time. We just had to notice.

Every backup file our users downloaded? That's a wallet. Every DID on the trust graph? That's a Solana address. The protocol wasn't designed. It was excavated from 37 days of building from the right principles.`,
    metadata: { layout: 'center' },
    sortOrder: 14,
  });

  // New slide 15: Token Economics
  console.log('Inserting: Token Economics');
  await db.insert(lessons).values({
    id: generateId('lsn'),
    moduleId,
    title: 'MJN: a settlement instrument, not a speculative asset.',
    contentType: 'slide',
    content: `Reserve-backed utility token. Dual-currency network — every transaction settles in fiat OR MJN. Nobody is forced into crypto.`,
    metadata: {
      layout: 'left',
      items: [
        'MJN-scoped wallets — blast radius contained. Not a general-purpose crypto wallet.',
        'Mint on fiat deposit, burn on fiat withdrawal. 1:1 reserve backing.',
        'Fixed exchange rate at launch → managed float at maturity.',
        'Foundation clearinghouse — holds reserves, publishes rates, operates gas pool.',
        'Hierarchical key derivation — spending, savings, delegation keys. Each revocable.',
        'Per-primitive governance — Individual wallets are simple. Family = multi-sig. Cultural = quorum. Org = delegation.',
        'Lower fees than Stripe (Solana tx ≈ $0.001). Instant settlement. Atomic .fair splits.',
      ],
    },
    sortOrder: 15,
  });

  // New slide 16: The Multi-Angle
  console.log('Inserting: The Multi-Angle');
  await db.insert(lessons).values({
    id: generateId('lsn'),
    moduleId,
    title: 'One architecture. Every angle is true.',
    contentType: 'slide',
    content: `What you're looking at depends on where you stand.`,
    metadata: {
      layout: 'left',
      table: {
        headers: ['Angle', 'What It Is'],
        rows: [
          ['Infrastructure', 'Trust-gated service architecture. 14 services, open protocol.'],
          ['Social', 'Human connection graph backed by Solana. Trust is the algorithm.'],
          ['Protocol', 'MJN — identity, attribution, consent, settlement. One keypair.'],
          ['Crypto', 'A social network where every user is a wallet.'],
          ['The real answer', 'All of these are the same thing from different entry points.'],
        ],
      },
    },
    sortOrder: 16,
  });

  // Update thesis slide (now sort_order 22)
  console.log('Updating: Thesis slide');
  await db.update(lessons).set({
    content: `The internet was built to move documents. Then packets. Neither carried the human.

Platforms filled the gap — and captured everything.

Imajin carries the human. Identity, trust, attribution, settlement — all in one protocol. For humans and agents alike.

We didn't design the protocol on a whiteboard. We built from the right primitives — keypairs, trust, attribution, consent — and the protocol revealed itself. The settlement layer was inside the identity layer. The agent layer was inside the trust layer. Each discovery was already in the git history, waiting.

Start from the human and you will find the protocol.`,
  }).where(eq(lessons.id, SLIDE_IDS.thesis));

  // Update closer slide
  console.log('Updating: Closer slide');
  await db.update(lessons).set({
    title: 'Start from the human.',
    content: `30 years of vision. 30 essays. 37 days of execution.

14 services. $1,589. Every user already a wallet. All open source.

The exit infrastructure is built. The protocol found itself. Now we scale it.`,
    metadata: {
      layout: 'center',
      cta: { text: 'imajin.ai', href: 'https://imajin.ai' },
    },
  }).where(eq(lessons.id, SLIDE_IDS.closer));

  console.log('\n✅ Pitch deck updated to v3!');
  console.log('   3 new slides inserted (Convergence, Token Economics, Multi-Angle)');
  console.log('   7 existing slides updated');
  console.log('   Present: learn.imajin.ai/course/imajin-pitch/present');

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
