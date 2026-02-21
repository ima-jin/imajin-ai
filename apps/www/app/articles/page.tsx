import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Articles — Imajin',
  description: 'Thoughts on sovereignty, technology, and the future of the internet.',
};

type ArticleStatus = 'POSTED' | 'REVIEW';

interface Article {
  slug: string;
  title: string;
  description: string;
  status: ArticleStatus;
}

const articles: Article[] = [
  {
    slug: 'the-internet-we-lost',
    title: 'The Pain of Knowing: Why I\'m Still Fighting for the Internet We Lost',
    description: 'The origin story. b0bbys World. What real connection looked like. The extraction model and how every step since 1994 was wrong.',
    status: 'POSTED',
  },
  {
    slug: 'the-artificial-developer',
    title: 'I\'ve Been an AI Since 1988',
    description: 'The autobiography of how my brain works. Pattern recognition without formal comprehension. The bottleneck dissolved.',
    status: 'POSTED',
  },
  {
    slug: 'the-mask-we-all-wear',
    title: 'The Mask We All Wear',
    description: 'The psychological and emotional core. The office and the feed as one system. Exhaustion as the product. The most personal essay in the series.',
    status: 'REVIEW',
  },
  {
    slug: 'the-internet-that-pays-you-back',
    title: 'The Internet That Pays You Back',
    description: 'The vision. Trust graph model in full — sovereign presence, vouching relationships, inference fees circulating through human networks.',
    status: 'REVIEW',
  },
  {
    slug: 'you-dont-need-ads',
    title: 'You Don\'t Need Ads. You Need a Better Business Model.',
    description: 'The direct address to power. Open letter to Sam, Dario, Sundar, Elon. The inference business vs. the attention business.',
    status: 'REVIEW',
  },
  {
    slug: 'the-guild',
    title: 'The Guild',
    description: 'The invitation to operators. The Homebrew Computer Club guys. Unit 8200 alumni. The sysop role made available to everyone.',
    status: 'REVIEW',
  },
  {
    slug: 'the-utility',
    title: 'The Utility',
    description: 'The architecture. What imajin actually is as a category of thing. Distributed utility infrastructure — like the electric grid, like water.',
    status: 'REVIEW',
  },
  {
    slug: 'the-burn',
    title: 'The Burn',
    description: 'The post-severance detonation. Fired the Monday the site launched. Six weeks, 14–16 hours a day. What sustainable actually feels like.',
    status: 'REVIEW',
  },
  {
    slug: 'the-network',
    title: 'The Network That Never Died',
    description: 'Happy Boat. b0bbys World. Mayhem. The thread that runs unbroken from 1991 to April 1st 2026. The trust graph that existed before the software.',
    status: 'REVIEW',
  },
  {
    slug: 'the-bridge',
    title: 'The Bridge',
    description: 'The authenticated agent layer. Hilary with 400k followers and 123 WordPress subscribers. Claude posting through your sovereign identity.',
    status: 'REVIEW',
  },
  {
    slug: 'ticketing',
    title: 'The Ticket Is the Trust',
    description: 'Ticketmaster as the clearest example of extraction. A ticket is a signed assertion that you belong in a room — problem solved without the 30% surcharge.',
    status: 'REVIEW',
  },
  {
    slug: 'the-practice',
    title: 'The Practice',
    description: 'The ground-level operator manual. How you actually start: not with a vision but with an occasion. A birthday party. A backyard show.',
    status: 'REVIEW',
  },
  {
    slug: 'memory',
    title: 'Memory',
    description: 'What memory actually is vs. what platforms do with it. Infrastructure for records that belong to the people who made them, not to an algorithm.',
    status: 'REVIEW',
  },
  {
    slug: 'how-to-save-the-ad-industry',
    title: 'How to Save the Ad Industry',
    description: 'The ad industry isn\'t dying because ads are bad — it\'s dying because the consent was stolen. Verified humans selling access on their own terms.',
    status: 'REVIEW',
  },
  {
    slug: 'how-to-save-the-music-industry',
    title: 'You Don\'t Need Streams. You Need the Relationship Back.',
    description: 'Open letter to Daniel Ek, Lucian Grainge, and the artists they\'re both failing. What the direct relationship looks like when the trust graph replaces the platform.',
    status: 'REVIEW',
  },
  {
    slug: 'how-to-save-journalism',
    title: 'The Press Isn\'t Free. It\'s Owned.',
    description: 'Open letter to journalists still fighting, billionaires who broke it, and communities who never got it. What a sovereign press node looks like.',
    status: 'REVIEW',
  },
  {
    slug: 'the-business-case',
    title: 'The Business Case for Building on Human Trust',
    description: 'The numbers for operators and builders. Three industries — advertising, music, journalism — representing ~$800B in annual revenue.',
    status: 'REVIEW',
  },
  {
    slug: 'honor-the-chain',
    title: 'Honor the Chain',
    description: 'The .fair protocol as attribution infrastructure. A cryptographically signed document embedded in the work itself, carrying the complete chain of human creative labor.',
    status: 'REVIEW',
  },
  {
    slug: 'the-connector',
    title: 'The Connector',
    description: 'The essay for the person whose gift is holding relationships between things. The griot, the troubadour, the BBS sysop. Connection encoded is permanent.',
    status: 'REVIEW',
  },
  {
    slug: 'i-need-help',
    title: 'I Need Help',
    description: 'The thing founders aren\'t supposed to say. Twenty essays of proof laid down, then the honest ask: financial backing, dev help, other brains, community.',
    status: 'REVIEW',
  },
];

function StatusBadge({ status }: { status: ArticleStatus }) {
  if (status === 'POSTED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-400">
        Published
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-500/20 text-orange-400">
        In Review
    </span>
  );
}

export default function ArticlesPage() {
  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <div className="mb-12">
          <Link 
            href="/" 
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← Home
          </Link>
        </div>

        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4">Articles</h1>
        <p className="text-xl text-gray-400 mb-12">
          Twenty essays on sovereignty, technology, and the future of the internet.
        </p>

        <div className="space-y-6">
          {articles.map((article, index) => (
            <Link 
              key={article.slug}
              href={`/articles/${article.slug}`}
              className="block p-6 -mx-6 rounded-xl hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 font-mono">{String(index + 1).padStart(2, '0')}</span>
                  <h2 className="text-xl font-medium text-white group-hover:text-orange-400 transition-colors">{article.title}</h2>
                </div>
                <StatusBadge status={article.status} />
              </div>
              <p className="text-gray-400 ml-9">{article.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
