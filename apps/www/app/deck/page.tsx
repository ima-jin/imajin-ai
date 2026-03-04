'use client';

import { useState, useEffect, useCallback } from 'react';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

interface Slide {
  title?: string;
  subtitle?: string;
  content: React.ReactNode;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-white/10 py-3">
      <span className="text-white/50">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function CompareRow({ provider, fee, total, highlight }: { provider: string; fee: string; total: string; highlight?: boolean }) {
  return (
    <div className={`flex justify-between py-3 border-b border-white/10 ${highlight ? 'text-white font-medium' : 'text-white/60'}`}>
      <span className="flex-1">{provider}</span>
      <span className="flex-1 text-right">{fee}</span>
      <span className="flex-1 text-right">{total}</span>
    </div>
  );
}

const slides: Slide[] = [
  // Slide 1: Founder
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-8">Ryan Veteze</h1>
        <div className="space-y-6 text-lg md:text-xl text-white/70 leading-relaxed">
          <p>Online since 1988. Ran a BBS at fifteen — three phone lines, three hundred people finding each other before the web existed.</p>
          <p>30 years building systems. Director-level, led 8 teams. Built a dance music network still running after 25 years.</p>
          <p>I watched the whole arc: the wonder, the capture, the extraction. I've been circling the same problem for three decades.</p>
          <p className="text-white">I finally know how to solve it.</p>
        </div>
      </div>
    ),
  },

  // Slide 2: Problem — Fees
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">3% of everything disappears.</h2>
        <div className="space-y-6 text-lg md:text-xl text-white/70 leading-relaxed">
          <p>Every card tap. Every online purchase. Visa, Mastercard, Stripe, the banks — all taking a cut before the money reaches the person who earned it.</p>
          <p>A small business doing $500K/year in transactions loses <span className="text-white font-medium">$15,000</span>. Every year. Forever.</p>
        </div>
      </div>
    ),
  },

  // Slide 3: Problem — Reputation
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">Your reputation isn't yours.</h2>
        <div className="space-y-4 text-lg md:text-xl text-white/70 leading-relaxed">
          <p>Your Yelp stars belong to Yelp.</p>
          <p>Your Airbnb rating vanishes when you switch platforms.</p>
          <p>Your Uber driver's 5,000 rides mean nothing on Lyft.</p>
          <p>Anyone can leave a review. Real customers can't prove they are one.</p>
          <p className="text-white/40 mt-8">Platforms hold reputation hostage because that's the lock-in. You can't leave because your history doesn't come with you.</p>
        </div>
      </div>
    ),
  },

  // Slide 4: The Insight
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-16">What if every transaction you made built your reputation?</h2>
        <div className="space-y-6">
          {['Identity — you are verifiable, not an account on someone else\'s platform',
            'Payments — money moves directly, not through middlemen',
            'Attribution — every transaction records who was involved',
            'Reputation — both sides credential each other from real transactions',
            'Trust graph — the network weighs credentials by history',
          ].map((item, i) => (
            <div key={i} className="flex gap-4 text-lg md:text-xl">
              <span className="text-white/30 font-mono">{i + 1}</span>
              <span className="text-white/80">{item}</span>
            </div>
          ))}
        </div>
        <p className="mt-12 text-white/40 text-lg">Each exists in isolation somewhere. We connected them.</p>
      </div>
    ),
  },

  // Slide 5: How It Works
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">The coffee shop version.</h2>
        <div className="space-y-4 text-lg md:text-xl font-mono text-white/60">
          <p>QR code on the window</p>
          <p className="pl-4">→ customer scans, joins with email</p>
          <p className="pl-8">→ loads wallet once</p>
          <p className="pl-12">→ every transaction after: ledger entry</p>
          <p className="pl-16">→ both sides auto-credentialed</p>
          <p className="pl-20 text-white">→ reputation builds itself</p>
        </div>
        <p className="mt-12 text-white/40 text-lg">No app download. No seed phrase. No platform account. Email → you're in.</p>
      </div>
    ),
  },

  // Slide 6: Economics
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-4">Closed-loop settlement.</h2>
        <p className="text-xl text-white/50 mb-10">Stripe touches the on-ramp. Once. Everything after is a ledger entry.</p>
        <div className="border border-white/10 rounded-lg p-6">
          <div className="flex justify-between py-2 border-b border-white/20 text-sm text-white/40 uppercase tracking-wider">
            <span className="flex-1">Provider</span>
            <span className="flex-1 text-right">Fee model</span>
            <span className="flex-1 text-right">$100 / 20 txns</span>
          </div>
          <CompareRow provider="Visa / Mastercard" fee="1.5–3.5% every time" total="$5–$7" />
          <CompareRow provider="Stripe" fee="2.9% + 30¢ every time" total="$9.00" />
          <CompareRow provider="Square" fee="2.6% + 10¢ every time" total="$7.20" />
          <CompareRow provider="Imajin (Phase 1)" fee="3% once + 1% protocol" total="$4.20" highlight />
          <CompareRow provider="Imajin (Phase 2)" fee="~0% on-ramp + 1%" total="$1.00" highlight />
        </div>
        <p className="mt-8 text-white/40">Money circulates inside the network. Vendor pays supplier from the same balance. Card networks never touch it again.</p>
      </div>
    ),
  },

  // Slide 7: Reputation Layer
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">Reputation that can't be faked.</h2>
        <div className="space-y-6 text-lg md:text-xl text-white/70">
          <p><span className="text-white">Bilateral.</span> Both parties credential each other on every transaction.</p>
          <p><span className="text-white">Anchored.</span> Each credential is cryptographically signed and linked to the real payment.</p>
          <p><span className="text-white">Permanent.</span> Neither party can delete the other's attestation. Both nodes hold copies.</p>
          <p><span className="text-white">Disputeable.</span> Signed response chains, not anonymous review wars.</p>
        </div>
        <p className="mt-12 text-white/40 text-lg">No settlement, no credential. The economics enforce the integrity.</p>
      </div>
    ),
  },

  // Slide 8: What We've Built
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-4">10 services. Live.</h2>
        <p className="text-xl text-white/50 mb-10">First transactions: March 2026.</p>
        <div className="grid grid-cols-2 gap-x-12 gap-y-2 text-lg">
          {[
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
          ].map(([name, desc]) => (
            <div key={name} className="flex gap-3 py-1">
              <span className="text-white font-mono">{name}</span>
              <span className="text-white/40">{desc}</span>
            </div>
          ))}
        </div>
        <p className="mt-10 text-white/40">All open source. All self-hostable. All consuming the same identity, payment, and attribution layers.</p>
      </div>
    ),
  },

  // Slide 9: Open Source / Decentralized
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">Open source. Decentralized. Unstoppable.</h2>
        <div className="space-y-6 text-lg md:text-xl text-white/70 leading-relaxed">
          <p>Every line of code is open source. Every service is self-hostable. Anyone can run a node.</p>
          <p><span className="text-white">Infrastructure is provided by local hosts all over the world.</span> Not our servers — a federated network of sovereign nodes, each owned by the person running it.</p>
          <p>The protocol takes a percentage on every transaction. That's the business model. The infrastructure is distributed. The value flows to the people running it.</p>
          <p className="text-white/40 mt-4">Nobody can shut it down because there's nothing central to shut down. No kill switch. No terms of service change. No rug pull. If we disappeared tomorrow, the network keeps running.</p>
        </div>
      </div>
    ),
  },

  // Slide 10: Landscape
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">Everyone built pieces.</h2>
        <div className="space-y-4 text-lg md:text-xl">
          {[
            ['IEEE researchers', 'wrote papers, not code'],
            ['Dock, Cheqd, Trinsic', 'credential plumbing for enterprise KYC'],
            ['Gitcoin, Lens, Farcaster', 'social reputation — popularity ≠ reliability'],
            ['Stripe, Square', 'payment rails with no interest in what happens after'],
            ['Yelp, Google', 'adversarial by design'],
          ].map(([who, what]) => (
            <div key={who} className="flex gap-4">
              <span className="text-white/80 min-w-[220px]">{who}</span>
              <span className="text-white/40">{what}</span>
            </div>
          ))}
        </div>
        <p className="mt-12 text-white text-xl">We built all five layers. The settlement is the anchor.</p>
      </div>
    ),
  },

  // Slide 11: Market
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">Every industry with captured reputation.</h2>
        <div className="space-y-4 text-lg md:text-xl text-white/70">
          <p><span className="text-white">Local commerce</span> — 33M small businesses in the US, ~$15K/year in card fees each</p>
          <p><span className="text-white">Hospitality</span> — 7M+ Airbnb listings with non-portable ratings</p>
          <p><span className="text-white">Rideshare</span> — 5.4M drivers trapped by platform reputation</p>
          <p><span className="text-white">Freelancing</span> — $1.5T market, zero portable reputation</p>
        </div>
        <div className="mt-12 space-y-2 text-white/40">
          <p>Same QR code. Same five layers. Different window.</p>
        </div>
      </div>
    ),
  },

  // Slide 12: Go-to-Market
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-12">One neighborhood at a time.</h2>
        <div className="space-y-8 text-lg md:text-xl">
          <div>
            <span className="text-white/30 font-mono text-sm uppercase tracking-wider">Phase 1</span>
            <p className="text-white/80 mt-2">10 businesses. QR codes. Real transactions. Prove the loop.</p>
          </div>
          <div>
            <span className="text-white/30 font-mono text-sm uppercase tracking-wider">Phase 2</span>
            <p className="text-white/80 mt-2">City-level clusters. Businesses recruit each other. Customers expect the sticker.</p>
          </div>
          <div>
            <span className="text-white/30 font-mono text-sm uppercase tracking-wider">Phase 3</span>
            <p className="text-white/80 mt-2">Platform API. Imajin becomes the identity and attribution layer underneath. The Stripe play.</p>
          </div>
        </div>
      </div>
    ),
  },

  // Slide 13: The Essays
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto text-center">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-8">30 essays.</h2>
        <p className="text-xl md:text-2xl text-white/50 mb-12">Part manifesto. Part technical documentation. Part founding story.</p>
        <p className="text-2xl md:text-4xl font-medium leading-relaxed">"The internet that pays you back."</p>
        <a
          href={`${PREFIX}${DOMAIN}/articles`}
          className="mt-12 text-white/40 hover:text-white transition-colors text-lg"
        >
          imajin.ai/articles →
        </a>
      </div>
    ),
  },

  // Slide 14: The Ask
  {
    content: (
      <div className="flex flex-col justify-center h-full max-w-3xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-4">$500K</h2>
        <p className="text-xl text-white/50 mb-12">Not a round. A milestone.</p>
        <div className="border border-white/10 rounded-lg p-6">
          <StatRow label="April 1 demo + first 90 days" value="40%" />
          <StatRow label="Go-to-market: first 10 business pilots" value="30%" />
          <StatRow label="Runway (founder + infrastructure)" value="30%" />
        </div>
        <div className="mt-10 space-y-3 text-lg text-white/60">
          <p>Live demo with real transactions.</p>
          <p>10 business pilots with QR onboarding.</p>
          <p>Federation between sovereign nodes.</p>
          <p>6 months to revenue.</p>
        </div>
      </div>
    ),
  },

  // Slide 15: The Vision
  {
    content: (
      <div className="flex flex-col justify-center items-center h-full max-w-3xl mx-auto text-center">
        <p className="text-xl md:text-2xl text-white/40 mb-8">The graph started with trust. Trust needed identity. Identity needed payments. Payments needed attribution. Attribution produced reputation. Reputation fed back into the trust graph.</p>
        <h2 className="text-4xl md:text-7xl font-bold tracking-tight mb-4">Five layers.</h2>
        <p className="text-2xl md:text-3xl text-white/60 mb-16">All connected. All sovereign. All open source.</p>
        <div className="space-y-4">
          <p className="text-2xl md:text-3xl font-bold">April 1, 2026.</p>
          <p className="text-xl md:text-2xl text-white/60">This is not a joke.</p>
          <a
            href={`${PREFIX}events.${DOMAIN}/jins-launch-party`}
            className="inline-block mt-6 text-white/40 hover:text-white transition-colors"
          >
            events.imajin.ai/jins-launch-party →
          </a>
        </div>
      </div>
    ),
  },
];

export default function DeckPage() {
  const [current, setCurrent] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');

  const goTo = useCallback((index: number) => {
    if (index < 0 || index >= slides.length) return;
    setDirection(index > current ? 'next' : 'prev');
    setCurrent(index);
  }, [current]);

  const next = useCallback(() => goTo(current + 1), [current, goTo]);
  const prev = useCallback(() => goTo(current - 1), [current, goTo]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        prev();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goTo(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        goTo(slides.length - 1);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [next, prev, goTo]);

  // Touch support
  const [touchStart, setTouchStart] = useState<number | null>(null);

  return (
    <div
      className="fixed inset-0 bg-[#0a0a0a] text-white overflow-hidden select-none"
      onTouchStart={(e) => setTouchStart(e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchStart === null) return;
        const diff = e.changedTouches[0].clientX - touchStart;
        if (Math.abs(diff) > 50) {
          diff > 0 ? prev() : next();
        }
        setTouchStart(null);
      }}
    >
      {/* Slide content */}
      <div className="h-full px-8 md:px-16 py-12 md:py-16 flex flex-col">
        <div className="flex-1 flex items-center">
          <div className="w-full" key={current}>
            {slides[current].content}
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between text-white/20 text-sm">
          <button
            onClick={prev}
            disabled={current === 0}
            className="hover:text-white/60 disabled:opacity-0 transition-colors px-4 py-2"
          >
            ←
          </button>

          <div className="flex items-center gap-1">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === current ? 'bg-white/60' : 'bg-white/10 hover:bg-white/30'
                }`}
              />
            ))}
          </div>

          <button
            onClick={next}
            disabled={current === slides.length - 1}
            className="hover:text-white/60 disabled:opacity-0 transition-colors px-4 py-2"
          >
            →
          </button>
        </div>
      </div>

      {/* Slide counter */}
      <div className="fixed top-6 right-8 text-white/20 text-sm font-mono">
        {current + 1} / {slides.length}
      </div>

      {/* imajin.ai watermark */}
      <div className="fixed top-6 left-8 text-white/20 text-sm tracking-wider">
        IMAJIN
      </div>
    </div>
  );
}
