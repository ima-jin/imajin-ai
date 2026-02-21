import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Business Case for Building on Human Trust',
  description: 'What the numbers actually mean — for the people doing the building. Three industries are broken in the same way. Almost none of the $800 billion reaches the humans who create the value.',
  openGraph: {
    title: 'The Business Case for Building on Human Trust',
    description: 'We reward wisdom and experience over everything else. The way it used to be.',
    url: 'https://imajin.ai/articles/the-business-case',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'The Business Case for Building on Human Trust',
    description: 'We reward wisdom and experience over everything else. The way it used to be.',
  },
};

export default function ArticlePage() {
  return (
    <main className="min-h-screen py-16 px-6">
      {/* Back link */}
      <div className="max-w-3xl mx-auto mb-12">
        <Link 
          href="/articles" 
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Articles
        </Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">
          The Business Case for Building on Human Trust
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          What the numbers actually mean — for the people doing the building
        </p>

        <p>Three industries are broken in the same way.</p>
        <p>
          Advertising. Music. Journalism. Combined they represent roughly <strong>$800 
          billion in annual revenue</strong> — money that exists, that people and businesses 
          are already spending, that already flows through the economy.
        </p>
        <p>Almost none of it reaches the humans who create the value.</p>
        <p>
          It flows instead to the platforms, the labels, the aggregators — the people who 
          own the rails. The artists, the journalists, the creators, the communities — they 
          get fractions. They get reach without revenue. They get audiences without 
          relationships. They get used and they don't get paid.
        </p>
        <p>
          Imajin is not asking you to create a new market. It's asking you to redirect a 
          small piece of an existing one through infrastructure that puts the money where 
          the value actually is.
        </p>
        <p>
          But first — we need to destroy the subscription model. Because the subscription 
          model is part of the problem.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Why Subscriptions Are Extractive</h2>
        <p>The subscription model was not designed for creators. It was designed for platforms.</p>
        <p>
          It works by capturing your payment information and your inertia simultaneously. 
          It charges you in months you barely engage. It buries cancellation flows behind 
          dark patterns. It depends on you forgetting you're paying — and on the friction 
          of stopping being higher than the friction of continuing.
        </p>
        <p>
          The platform holds the money. The platform decides how to distribute it. The 
          creator gets an opaque fraction of a pool, calculated by an algorithm they don't 
          control, paid on a schedule that serves the platform's cash flow. The journalist 
          doesn't know if you read the article or just opened the tab. The artist has no 
          idea if you listened to one song or a hundred. Everything flattens into a monthly 
          fee that disappears into a void.
        </p>
        <p>The subscription model is extraction wearing the costume of support.</p>
        <p>We destroy it completely.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Model: Turn-Based, Transparent, Yours</h2>
        <p>
          You deposit credit into your account. Not a subscription. Not a recurring charge. 
          A deposit — like loading a transit card — that you control entirely.
        </p>
        <p>
          That credit only moves when you consume human creativity and human intelligence. 
          Directly. Visibly. In real time.
        </p>
        <p>The pricing reflects the actual value of what you're consuming:</p>
        <ul>
          <li>Chatting on a node — <strong>$0.0001</strong></li>
          <li>Reading an article — <strong>$0.08</strong></li>
          <li>Downloading a song — <strong>$0.10</strong></li>
          <li>An inference query against a creator's body of work — <strong>$0.01 per token</strong></li>
          <li>Your catalogue used to generate a remix — <strong>$3.00</strong> + an automatically executed attribution contract that compensates every contributor in the chain, at the moment of creation, with no lawyers and no clearance process</li>
        </ul>
        <p>
          Every transaction is visible. Every cent is traceable. You can see, in real time, 
          exactly where your attention is going and exactly who it's compensating.
        </p>
        <p>
          When your balance hits a threshold you set, it reloads automatically. No surprise 
          charges. No dark patterns. No platform holding money that should be moving.
        </p>
        <p>
          And every payment goes directly to the human whose work you just consumed. Not to 
          a platform that decides later how much to pass on. Not to a label taking 80% 
          before the artist sees anything. Directly. Immediately. Through sovereign 
          infrastructure with no landlord in the middle.
        </p>
        <p>
          This is not a new payment model. It's the oldest payment model — you valued 
          something, you paid for it, the person who made it received the payment — rebuilt 
          for the internet with the extraction layer removed.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The .fair Protocol: Attribution as Infrastructure</h2>
        <p>
          Here is a problem so old and so accepted that most people stopped seeing it as a 
          problem.
        </p>
        <p>
          A producer samples a bass line from a recording made in 1973. A journalist builds 
          an investigation on a source's tip that took years to cultivate. A remix artist 
          takes three records, a vocal hook, and a drum pattern and makes something new 
          from all of them. A developer trains a model on a body of writing that took a 
          decade to produce.
        </p>
        <p>
          In every one of these cases, value was created from prior human creative work. 
          In almost none of these cases does the human whose work was used receive any 
          compensation. In almost none of these cases is there even a legible record of 
          the connection.
        </p>
        <p>
          The .fair protocol is the infrastructure layer that finally solves this. Not 
          through lawyers. Not through licensing databases controlled by labels. Through 
          the work itself.
        </p>
        <p>
          Every piece of creative work published on a node carries a .fair manifest — a 
          cryptographically signed document embedded in the file that contains the complete 
          attribution chain for that work. Who made it. Who contributed to it. What prior 
          work it derives from. What terms govern its use. What compensation flows 
          automatically when those terms are triggered.
        </p>
        <p>
          The manifest travels with the work. Not in a platform database that can be 
          altered or taken offline. Not in a rights management system controlled by a 
          label. In the file itself. Immutable. Cryptographically verifiable. Owned by 
          nobody except the chain of humans whose creativity it documents.
        </p>
        <p>
          When someone uses your catalogue to generate a remix — that $3.00 transaction 
          doesn't just pay you. It executes the attribution chain encoded in your manifest. 
          Automatically. At the moment of creation. The original artist receives their 
          share. The producer who mixed the source recording receives theirs. The session 
          musician whose bass line is in the sample. The songwriter whose chord progression 
          underlies the new work. Every contributor documented in the chain receives their 
          attributed portion, governed by the terms they set when they published the work, 
          without negotiation, without lawyers, without clearance processes, without hoping 
          nobody notices.
        </p>
        <p>
          The contract isn't negotiated after the fact. It's embedded in the work before it 
          ever leaves the node. The terms travel with the music. The compensation executes 
          when the trigger happens.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Three People This Is Built For</h2>

        <h3>The Creator</h3>
        <p>The Creator puts more value into the network than they take out. Their node is the asset.</p>
        <p>
          Everything they have ever made — every article, every song, every recording, 
          every essay, every body of work accumulated across a career — lives on their node 
          as a catalogue. A living, queryable, compensable asset.
        </p>
        <p>
          This is the thing the streaming model destroyed and this model restores: <strong>the 
          catalogue earns</strong>.
        </p>
        <p>
          On Spotify, work from ten years ago is effectively invisible. The algorithm 
          surfaces new releases. Old work is buried. A decade of extraordinary music 
          competes on equal footing with something posted this morning — and loses, because 
          the platform rewards recency and novelty, not depth and accumulation.
        </p>
        <p>
          On the trust graph, the older and richer the catalogue, the more valuable the 
          node. Every query against a body of work — every remix, every inference, every 
          person asking what this artist thought about a particular chord progression or 
          what this journalist knew about a particular institution — generates a flow back 
          to the creator. The person who has been building for thirty years earns more than 
          the person who arrived last week. Wisdom and experience compound economically for 
          the first time.
        </p>

        <h3>The Consumer</h3>
        <p>
          The Consumer mostly reads, listens, watches. They don't create. They deposit 
          credit and spend it on what matters to them.
        </p>
        <p>And here is the thing that changes everything for them: <strong>they can see it</strong>.</p>
        <p>
          Not a monthly subscription vanishing into a corporate account. A visible ledger. 
          Eight cents to read this article — and they can see that eight cents land on the 
          journalist's node. Ten cents to download this song — and they can see that ten 
          cents reach the artist directly. Three dollars for a remix that drew on a 
          catalogue — and they can see exactly how that three dollars was distributed 
          across every creator whose work contributed.
        </p>
        <p>
          Their attention becomes visible to them for the first time. The connection between 
          what they value and what they fund is direct and immediate and legible.
        </p>

        <h3>The Creator/Consumer</h3>
        <p>
          The Creator/Consumer is the most interesting type — and probably the majority of 
          people in the network.
        </p>
        <p>
          They don't have a massive catalogue. They're not primarily consumers either. 
          They're cultural nodes. The friend who always knows the right article. The 
          colleague whose taste everyone trusts. The person whose recommendation carries 
          weight in their community because they've been paying attention for years and 
          their judgment has proven reliable.
        </p>
        <p>Right now that person gets nothing. Their curation, their taste, their recommendations — all of it is extracted by platforms and monetized by algorithms that learn from their behavior without compensating them for it.</p>
        <p>On the trust graph, curation earns.</p>
        <p>
          Not enough to live on for most Creator/Consumers. But enough to feel real. Enough 
          to maintain a small positive balance in the system — their outflows covered in 
          part by the inflows from being a genuine cultural node for the people around them. 
          Enough to make the work they were already doing feel valued rather than invisible.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>What This Does to the Three Broken Industries</h2>

        <h3>Advertising: $700 Billion Looking for a Better Model</h3>
        <p>
          Global digital advertising is $700 billion annually — built on approximating 
          something that now exists directly. A trusted human recommending something to 
          someone who trusts them.
        </p>
        <p>
          <strong>At human scale:</strong> An operator running a node for a community of 
          2,000 people, routing recommendations and queries, earning inference fees on 
          every transaction — that's a viable livelihood. Owned by the person running it. 
          Accountable to the community it serves.
        </p>
        <p>
          <strong>At network scale:</strong> Even redirecting 1% of global digital ad spend 
          through sovereign trust infrastructure is $7 billion annually flowing through 
          human relationships instead of platform intermediaries.
        </p>

        <h3>Music: $100 Billion, 12% to Artists</h3>
        <p>
          Artists receive somewhere between 12 and 16 cents of every dollar the music 
          economy generates. A million streams pays approximately $4,000 — split across 
          everyone who touched the work before it reached the listener.
        </p>
        <p>The trust graph changes the unit of exchange from streams to transactions.</p>
        <p>
          <strong>At human scale:</strong> An artist with 5,000 people consuming their work 
          at an average of $5 monthly equivalent — through downloads, queries, remixes, 
          direct conversations — earns $300,000 annually. Without a label. Without a 
          platform. Sustained entirely by the relationship between the artist and the 
          people who value what they built.
        </p>
        <p>
          <strong>At network scale:</strong> 500,000 artists each sustaining communities of 
          1,000 genuine consumers generates $30 billion annually flowing directly to 
          artists. Matching total global recorded music revenue. Distributed to the people 
          who actually made it.
        </p>

        <h3>Journalism: $150 Billion, Democracy Failing</h3>
        <p>
          Local news has lost more than half its revenue in fifteen years. The 
          accountability journalism gap — the stories not being told because no business 
          model supports telling them — has created governance blind spots that compound 
          quietly and expensively.
        </p>
        <p>
          The trust graph creates a direct economic relationship between a community and 
          the accountability infrastructure it depends on.
        </p>
        <p>
          <strong>At human scale:</strong> A beat reporter whose community of 10,000 readers 
          pays an average of $8 monthly equivalent through article reads, queries, and 
          direct access earns $960,000 annually. More than any legacy newsroom ever paid 
          them. For the work they were already doing. Owned by them, not an institution 
          that can fold.
        </p>
        <p>
          <strong>At network scale:</strong> 10,000 communities each sustaining local 
          accountability journalism at $10 average monthly spend is a $1.2 billion annual 
          market that currently does not exist — because the infrastructure to support 
          direct community funding of journalism has never existed before.
        </p>
        <p>Until now.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Flywheel That Can't Be Captured</h2>
        <p>
          Every Creator node that deepens its catalogue becomes more valuable over time. 
          Every Consumer whose ledger grows more visible becomes more connected to the 
          humans they're funding. Every Creator/Consumer whose curation proves reliable 
          accumulates standing that generates more inflow. Every community that builds 
          genuine accountability journalism infrastructure has more reason to deepen it.
        </p>
        <p>
          The network compounds not through engineered virality but through the same 
          mechanism that has always made human communities work: trust accumulates. Wisdom 
          becomes visible. Experience gets rewarded.
        </p>
        <p>
          The moat is not the technology. Any sufficiently funded team can build the 
          technology.
        </p>
        <p>
          The moat is the accumulated human trust that no competitor can replicate by 
          training a better model or raising a bigger round. The Creator who has thirty 
          years of catalogue on their node. The Consumer whose visible ledger represents 
          three years of genuine cultural engagement. The Creator/Consumer whose curation 
          has been reliable for a decade and whose standing in the network reflects it.
        </p>
        <p>We reward wisdom and experience over everything else.</p>
        <p>The way it used to be.</p>
        <p>The way it should always have been.</p>
        <p>Come build on rails that can't be owned.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai aka b0b</p>

        <hr className="my-12 border-gray-800" />

        <p><strong>If you want to follow along:</strong></p>
        <ul>
          <li>The code: <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer">github.com/ima-jin/imajin-ai</a></li>
          <li>The network: <a href="https://imajin.ai">imajin.ai</a></li>
          <li>Jin's party: April 1st, 2026</li>
        </ul>

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
