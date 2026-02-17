import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Internet We Lost — Imajin',
  description: 'Why BBS culture beat social media, and how we\'re building the alternative.',
};

export default function ArticlePage() {
  return (
    <main className="min-h-screen py-16 px-6">
      {/* Back link */}
      <div className="max-w-3xl mx-auto mb-12">
        <Link 
          href="/" 
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Back
        </Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">
          The Internet We Lost
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          Why BBS culture beat social media
        </p>

        <h2>The Pain of Knowing</h2>
        <p>
          Between 1990 and 1992, I ran a 3-node BBS called b0bbys World. It was a music distribution 
          hub focused on the demoscene. Three phone lines. Three modems. Three people could be 
          connected at once.
        </p>
        <p>
          Every day, people would dial in. They'd check their favorite message channels for new posts. 
          They'd download the latest .MOD files. Sometimes they'd play a door game with another user 
          who happened to be online. Then they'd log off, and someone else would dial in.
        </p>
        <p>
          It was slow. It was intentional. It was curated. It was <em>perfect</em>.
        </p>
        <p>And then the web came.</p>

        <h2>I Knew It Was Worse From the Beginning</h2>
        <p>
          I remember the exact feeling. Not nostalgia — I had that in real-time. Watching the BBS 
          networks dissolve into web forums. Watching web forums get absorbed into social networks. 
          Watching social networks become algorithmic feeds optimized for engagement.
        </p>
        <p>Every step — every single one — was celebrated as innovation.</p>
        <p>Every step was wrong.</p>
        <p>Here's what we lost:</p>
        <ul>
          <li><strong>The hub became a feed.</strong> Instead of going TO a place you cared about, content was pushed AT you.</li>
          <li><strong>Rituals became scrolling.</strong> Instead of checking your channels with intention, you refreshed compulsively.</li>
          <li><strong>Community became audience.</strong> Instead of 50 people who knew each other, you had 50,000 followers who were strangers.</li>
          <li><strong>Curation became algorithm.</strong> Instead of a sysop who cared, you had AI optimizing for advertiser revenue.</li>
        </ul>

        <h2>When Plumbing Becomes Profit</h2>
        <p>
          Here's the fatal architectural flaw of the modern internet: <strong>the platforms monetized 
          the infrastructure instead of letting value be created ON the infrastructure.</strong>
        </p>
        <p>
          When you run a BBS, the cost is the cost: phone lines, hardware, your time. You do it 
          because you care about the thing — the music, the community, the conversation. The value 
          created is in what people make and share.
        </p>
        <p>The plumbing is just plumbing.</p>
        <p>
          But when venture capital got involved, the plumbing had to become the profit center. 
          Capture users. Extract attention. Harvest data. Insert friction. Grow infinitely.
        </p>
        <p>
          This is why every platform follows the same trajectory: start useful and free, get users 
          hooked, introduce ads, reduce organic reach, make people pay to reach their own followers, 
          optimize for addiction, enshittify.
        </p>

        <h2>The Extraction Model is Fatally Flawed</h2>
        <p>
          The extraction model destroys the thing it's extracting from. Social platforms need 
          authentic human connection to function. But optimizing for engagement over connection 
          destroys authenticity.
        </p>
        <p>
          People stop posting what matters and start posting what performs. The algorithm learns 
          to serve rage and anxiety. The town square becomes a dopamine casino. Users burn out.
        </p>
        <p>The model is collapsing under its own contradictions.</p>

        <p>
          And no — this isn't Mastodon. Mastodon decentralized the social network: same paradigm, 
          distributed hosting. I'm building the identity and payment rails that social networks 
          (and everything else) should have been built on from the start. The plumbing, not the app.
        </p>

        <h2>What I'm Building</h2>
        <p>
          I'm building infrastructure. Sovereign infrastructure for identity, payments, and attribution.
        </p>
        <ul>
          <li><strong>You own your identity.</strong> A decentralized identifier (DID) that no platform can revoke.</li>
          <li><strong>You own your data.</strong> It lives on your node, not in someone's cloud.</li>
          <li><strong>You choose what to share.</strong> Spotify sees your music taste. LinkedIn sees your work history. Neither sees the other. You grant access selectively — and revoke it whenever you want.</li>
          <li><strong>Payments are plumbing.</strong> Built in, frictionless, direct. No platform taking 30%.</li>
          <li><strong>Attribution is protocol.</strong> Who made what. Who gets paid. No obfuscation.</li>
          <li><strong>Connections are intentional.</strong> One by one. No algorithmic suggestions.</li>
        </ul>
        <p>
          This is the inversion: platforms currently take everything by default, and you beg for 
          privacy settings. Sovereign infrastructure means you own everything by default, and you 
          selectively grant access. Prove you're over 18 without revealing your birthdate. Share 
          your email with one service but not another. Your call, every time.
        </p>
        <p>It's the BBS model, rebuilt for 2026. Slow. Intentional. Curated. Owned.</p>

        <h2>The Town Square Returns</h2>
        <p>
          When the plumbing is just plumbing — not monetized, not surveilled, not optimized for 
          extraction — something beautiful happens: <strong>value gets created in town squares where 
          people gather to trade human things.</strong>
        </p>
        <p>Art. Music. Skills. Labor. Ideas. Friendship.</p>
        <p>This is what the internet could have been. This is what it still can be.</p>

        <h2>April 1st, 2026</h2>
        <p>
          I'm launching with an April Fool's Day party. Jin — an AI presence living in a 512-LED 
          volumetric cube — is throwing the first event on the sovereign network. First real 
          transaction proving the stack works end-to-end.
        </p>
        <p>People will think it's a joke. Let them.</p>
        <p>
          April 2nd, Jin will still be there. The network will still work. And nobody will be able 
          to shut it down because nobody controls it.
        </p>

        <hr className="my-12 border-gray-800" />

        <p>
          The code: <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer">github.com/ima-jin/imajin-ai</a>
        </p>
        <p>See you in the town square.</p>
        <p className="text-gray-500">— bobby</p>

        {/* CTA */}
        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link
            href="/register"
            className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
          >
            Get Updates
          </Link>
        </div>
      </article>
    </main>
  );
}
