import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { lessons } from '../src/db/schema';

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function main() {
  const id = 'lsn_' + Date.now().toString(36) + crypto.randomUUID().replace(/-/g, '').substring(0, 13);

  // Shift milestones slide (21) and everything after up by 1
  await sql.unsafe(`UPDATE learn.lessons SET sort_order = sort_order + 1 WHERE module_id = 'mod_mmi48efrb6b1b4bf7efc4' AND sort_order >= 21`);

  await db.insert(lessons).values({
    id,
    moduleId: 'mod_mmi48efrb6b1b4bf7efc4',
    title: 'Why now. Why this.',
    contentType: 'slide',
    content: `You're investing in the settlement layer of the post-platform internet at the moment the protocol discovered itself.

Every identity is already a wallet. The infrastructure is built. The token economics are designed for stability, not hype. Your upside is proportional to every transaction that ever flows through this network.`,
    metadata: {
      layout: 'left',
      table: {
        headers: ['Analogue', 'What They Invested In', 'Outcome'],
        rows: [
          ['Visa (1970)', 'Payment rail between banks', '$500B company, $15T/year volume'],
          ['Stripe (2011)', 'Developer payment API', '$95B, $1T/year volume'],
          ['Cloudflare (2009)', 'Internet infrastructure', '$35B, 20%+ of web traffic'],
          ['Imajin (2026)', 'Identity + trust + settlement protocol', 'You are here'],
        ],
      },
      items: [
        'Equity in Imajin Inc. — the reference implementation and first node operator. Revenue from settlement fees, mint/burn spread, gas pool margin.',
        'Token allocation — MJN at fixed rate. When network volume triggers managed float, early holders bought at the floor.',
        'Protocol economics — every transaction on every node generates revenue. Growth is network-wide, not product-specific.',
        '14 services live. ~73 identities. Real transactions settled. Protocol discovered its own settlement layer on Day 37.',
        'The $1M buys 10 community nodes in Toronto, federation between nodes, and the transition from prototype to network.',
      ],
    },
    sortOrder: 21,
  });

  console.log('Inserted investor slide: ' + id);
  await sql.end();
}

main().catch(console.error);
