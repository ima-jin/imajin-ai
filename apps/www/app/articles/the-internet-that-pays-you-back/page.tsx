import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Internet That Pays You Back — Imajin',
  description: 'Trust graphs, sovereign presence, and the architecture of connection. UBI that emerges from architecture rather than redistribution.',
  openGraph: {
    title: 'The Internet That Pays You Back',
    description: 'Trust graphs, sovereign presence, and the architecture of connection.',
    url: 'https://imajin.ai/articles/the-internet-that-pays-you-back',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
};

export default function ArticlePage() {
  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto mb-12">
        <Link href="/articles" className="text-gray-500 hover:text-gray-300 transition-colors">← Articles</Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Internet That Pays You Back</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">Trust graphs, sovereign presence, and the architecture of connection</p>

        <p>We built the most connected network in human history and ended up lonelier — and more broke — than ever.</p>

        <p>That's not an accident. It's architecture.</p>

        <p>Every platform you use was built on the same foundational assumption: your attention is the product. Your relationships are the rails. Your data is the inventory. The platform is the landlord, and you pay rent with your time, your privacy, and your capacity to think clearly.</p>

        <p>We accepted this because we didn't know there was another way.</p>

        <p>There is another way.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Question That Changed Everything</h2>

        <p>Here's a thought experiment:</p>

        <p>You're the person your friends call. The one who knows things. When someone needs advice on a contractor, a laptop, a career decision, a political question — they text you. You answer. For free. Every time. Until you're depleted.</p>

        <p>What if you had an AI that knew your context — your opinions, your expertise, how you think, what you value — and could answer on your behalf?</p>

        <p>Not generic AI. <em>You</em>-shaped AI.</p>

        <p>Call it Ask Ryan. Or Ask [your name here].</p>

        <p>Someone in your trust network has a question. Your presence answers it the way you would — based on everything you've written, everything you've said, everything you believe. Your calendar, your expertise, your stated values, your accumulated conversations. Ninety percent of queries never reach you. The ones that are too hard, too personal, or genuinely new — those escalate to the real you.</p>

        <p>Here's the part that changes everything: <strong>they pay for the inference.</strong></p>

        <p>Not to a platform. Not to an advertiser. Directly to you.</p>

        <p>You're not the product anymore. You're the service.</p>

        <p>And here's what nobody mentions about this: onboarding collapses. New people in your network don't hit a blank generic model. They query through people who already know them. The community's culture, preferences, and accumulated context travel with every query. The AI speaks in your community's voice because your community's relationships are the filter. Cultural fit is immediate. Nobody has to teach the model who they are.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Why It Has to Be Trust-Bound</h2>

        <p>Open AI surfaces get wrecked. Prompt injection. Bad actors. Harassment. The internet finds a way to destroy everything left unguarded.</p>

        <p>So your presence is trust-bound. Invitation only. You control who has access, and at what resolution. Your close circle gets more of you. Acquaintances get less. Strangers can't reach you at all — unless someone vouches for them.</p>

        <p>This creates something the internet hasn't had in thirty years: real scarcity.</p>

        <p>Not manufactured FOMO. Not artificial limits engineered to drive engagement. Actual scarcity. There is only one you. Your trust network is finite. Your perspective is genuinely unique. And anyone trying to abuse your presence leaves a signed trail — every query is attributed, every bad actor has a return address.</p>

        <p>Injection attacks aren't just blocked. They're evidence.</p>

        <p>That's not a security feature. That's a legal primitive. When your agent handles real economic activity, attacking it becomes something closer to fraud. The network self-polices because getting caught attacking someone's presence doesn't just expose you — it collapses your standing with everyone connected to you.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Graph That Thinks Like a Village</h2>

        <p>Your presence connects to others. Trust relationships form a mesh. Alice is in your graph — you can query her directly. Bob isn't in your graph, but Alice trusts him. You can reach Bob through Alice, weighted accordingly. The path is visible: you → Alice → Bob. Two hops.</p>

        <p>Everyone in that chain has skin in the game.</p>

        <p>If you abuse a connection, it reflects on everyone who vouched for you. If you vouch for someone who later causes harm, your trust score takes a hit too. High-trust people become genuinely discerning because their own standing is on the line. That's not a punishment system — it's the social physics of every functional human community that ever existed, finally encoded in software.</p>

        <p>And depth in this graph isn't a punishment. Being five hops from the network's genesis doesn't make you less trustworthy — it just means queries cost more to route to you. Depth is routing information. Trust is local and earned. The person at depth eight who has built strong relationships and vouched well for people is more trustworthy than a depth-two bad actor.</p>

        <p>This keeps the network from calcifying into a hierarchy of early adopters. Late arrivals who build genuine relationships rise. Position doesn't confer permanent advantage. Behavior does.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What the Graph Does With Bad Actors</h2>

        <p>Here's the question people always ask: what stops bad actors from corrupting the network?</p>

        <p>The honest answer is: nothing has to. The architecture handles it without intervention.</p>

        <p>A bad actor node — a scam ring, a disinfo operation, a community built around harm — can only grow through real vouching relationships. The people who will genuinely vouch for them are people like them. So their subgraph closes in on itself. Not because anyone banned them. Not because a moderation team made a judgment call. Because the actual structure of their real social reality is what it is.</p>

        <p>This isn't quarantine. It's just the natural shape of human trust made visible.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party. First transaction on sovereign infrastructure. The trust graph, working.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
