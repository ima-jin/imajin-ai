import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { lessons } from '../src/db/schema';
import { eq } from 'drizzle-orm';

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function main() {
  // Update Ask slide
  await db.update(lessons).set({
    title: '$1.5M',
    content: 'Not a round. A milestone. First institutional capital into working infrastructure.',
    metadata: {
      layout: 'left',
      stats: [
        { label: 'Community nodes — 10 Toronto deployments', value: '30%' },
        { label: 'Protocol development — federation, on-chain registry, agent gateway', value: '25%' },
        { label: 'Team — first hires (community, engineering)', value: '20%' },
        { label: 'MJN Foundation — Swiss Stiftung, FINMA classification, fiat bridge legal', value: '12%' },
        { label: 'Runway — founder + infrastructure', value: '13%' },
      ],
    },
  }).where(eq(lessons.id, 'lsn_mmi48ekqb315baebc3d24'));
  console.log('Updated: $1.5M ask slide');

  // Update Milestones slide
  await db.update(lessons).set({
    content: 'What $1.5M buys in 12 months:',
    metadata: {
      layout: 'left',
      items: [
        '10 community nodes live in Toronto with real daily transaction volume.',
        'Federation between sovereign nodes — your data moves with you.',
        'MJN Foundation incorporated in Switzerland. FINMA utility token classification secured.',
        'Agent gateway — trust-gated inference routing as a service.',
        'First protocol revenue — settlement fees flowing from real transactions.',
        '1,000+ identities on the trust graph with organic growth.',
        'On-chain registry on Solana — decentralized node discovery.',
        'Fiat bridge live — users convert between dollars and MJN seamlessly.',
      ],
    },
  }).where(eq(lessons.id, 'lsn_mmi48ekye90d77143f664'));
  console.log('Updated: Milestones slide');

  await sql.end();
}

main().catch(console.error);
