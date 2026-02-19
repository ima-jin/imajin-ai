import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Internet That Pays You Back — Imajin',
  description: 'We built the most connected network in human history and ended up lonelier — and more broke — than ever. That\'s not an accident. It\'s architecture.',
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
          The Internet That Pays You Back
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          Trust graphs, sovereign presence, and the architecture of connection
        </p>

        <p>
          We built the most connected network in human history and ended up lonelier — and more 
          broke — than ever.
        </p>
        <p>That's not an accident. It's architecture.</p>
        <p>
          Every platform you use was built on the same foundational assumption: your attention is 
          the product. Your relationships are the rails. Your data is the inventory. The platform 
          is the landlord, and you pay rent with your time, your privacy, and your capacity to 
          think clearly.
        </p>
        <p>We accepted this because we didn't know there was another way.</p>
        <p>There is another way.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Question That Changed Everything</h2>
        <p>Here's a thought experiment:</p>
        <p>
          You're the person your friends call. The one who knows things. When someone needs advice 
          on a contractor, a laptop, a career decision, a political question — they text you. You 
          answer. For free. Every time. Until you're depleted.
        </p>
        <p>
          What if you had an AI that knew your context — your opinions, your expertise, how you 
          think, what you value — and could answer on your behalf?
        </p>
        <p>Not generic AI. <em>You</em>-shaped AI.</p>
        <p>Call it Ask Ryan. Or Ask [your name here].</p>
        <p>
          Someone in your trust network has a question. Your presence answers it the way you 
          would — based on everything you've written, everything you've said, everything you 
          believe. Your calendar, your expertise, your stated values, your accumulated 
          conversations. Ninety percent of queries never reach you. The ones that are too hard, 
          too personal, or genuinely new — those escalate to the real you.
        </p>
        <p>Here's the part that changes everything: <strong>they pay for the inference.</strong></p>
        <p>Not to a platform. Not to an advertiser. Directly to you.</p>
        <p>You're not the product anymore. You're the service.</p>
        <p>
          And here's what nobody mentions about this: onboarding collapses. New people in your 
          network don't hit a blank generic model. They query through people who already know 
          them. The community's culture, preferences, and accumulated context travel with every 
          query. The AI speaks in your community's voice because your community's relationships 
          are the filter. Cultural fit is immediate. Nobody has to teach the model who they are.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Why It Has to Be Trust-Bound</h2>
        <p>
          Open AI surfaces get wrecked. Prompt injection. Bad actors. Harassment. The internet 
          finds a way to destroy everything left unguarded.
        </p>
        <p>
          So your presence is trust-bound. Invitation only. You control who has access, and at 
          what resolution. Your close circle gets more of you. Acquaintances get less. Strangers 
          can't reach you at all — unless someone vouches for them.
        </p>
        <p>This creates something the internet hasn't had in thirty years: real scarcity.</p>
        <p>
          Not manufactured FOMO. Not artificial limits engineered to drive engagement. Actual 
          scarcity. There is only one you. Your trust network is finite. Your perspective is 
          genuinely unique. And anyone trying to abuse your presence leaves a signed trail — 
          every query is attributed, every bad actor has a return address.
        </p>
        <p>Injection attacks aren't just blocked. They're evidence.</p>
        <p>
          That's not a security feature. That's a legal primitive. When your agent handles real 
          economic activity, attacking it becomes something closer to fraud. The network 
          self-polices because getting caught attacking someone's presence doesn't just expose 
          you — it collapses your standing with everyone connected to you.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Graph That Thinks Like a Village</h2>
        <p>Here's where it gets interesting.</p>
        <p>
          Your presence connects to others. Trust relationships form a mesh. Alice is in your 
          graph — you can query her directly. Bob isn't in your graph, but Alice trusts him. 
          You can reach Bob through Alice, weighted accordingly. The path is visible: you → 
          Alice → Bob. Two hops.
        </p>
        <p>Everyone in that chain has skin in the game.</p>
        <p>
          If you abuse a connection, it reflects on everyone who vouched for you. If you vouch 
          for someone who later causes harm, your trust score takes a hit too. High-trust people 
          become genuinely discerning because their own standing is on the line. That's not a 
          punishment system — it's the social physics of every functional human community that 
          ever existed, finally encoded in software.
        </p>
        <p>
          And depth in this graph isn't a punishment. Being five hops from the network's genesis 
          doesn't make you less trustworthy — it just means queries cost more to route to you. 
          Depth is routing information. Trust is local and earned. The person at depth eight who 
          has built strong relationships and vouched well for people is more trustworthy than a 
          depth-two bad actor.
        </p>
        <p>
          This keeps the network from calcifying into a hierarchy of early adopters. Late 
          arrivals who build genuine relationships rise. Position doesn't confer permanent 
          advantage. Behavior does.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Three Tiers</h2>
        <p>The network has three kinds of existence:</p>
        <p>
          <strong>Nodes</strong> — people with their own presence. An AI trained on their context, 
          queryable by their trust network.
        </p>
        <p>
          <strong>Edges</strong> — trust relationships between nodes. Who can query whom, at what 
          weight, through what path.
        </p>
        <p>
          <strong>Mentions</strong> — people who don't have a presence yet, but exist in the data 
          of people who do.
        </p>
        <p>That third tier matters more than it sounds.</p>
        <p>
          You meet someone on the street. You don't know them. You query your network: "Anyone 
          know this person?"
        </p>
        <p>
          They're not a node. But your friend's AI remembers them from a collaboration last year. 
          Someone else's presence has a passing mention. Scattered across multiple contexts, a 
          picture assembles — no single person controls it, no central authority curates it.
        </p>
        <p>
          The network knows you before you join it. Word of mouth, but instant and queryable. 
          You show up in graphs as a mention, validated by your appearance across multiple 
          independent contexts. That's the cold start solved without a central authority.
        </p>
        <p>
          And every one of those queries — from the moment you're a mention to the moment you're 
          a fully established node — generates inference fees flowing back through the graph to 
          the people whose context shaped the answer. The network pays you back in proportion to 
          the value you've built into it.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Score Nobody Owns</h2>
        <p>
          Social scoring isn't new. PageRank, EigenTrust, reputation systems in peer-to-peer 
          networks — the math has been around for decades. China's Social Credit System uses 
          similar models. So do credit scores.
        </p>
        <p>The difference has never been the math. It's who controls it.</p>
        <p>
          Centralized social scores are terrifying because an authority decides your ranking. 
          They can downgrade you for dissent. The algorithm serves the state or the corporation, 
          and you have no recourse.
        </p>
        <p>
          This is the opposite. You own your node. You own your trust edges. You decide who can 
          query you. There's no global ranking — just local networks of people who actually know 
          each other, whose scores emerge from their actual behavior over time.
        </p>
        <p>Open source. Auditable. Sovereign.</p>
        <p>Same math that powers dystopian social credit. Radically different power structure.</p>
        <p>
          And because the score is open source, it can't be secretly manipulated. If someone 
          claims you're untrustworthy, you can see exactly why, exactly which relationships 
          contributed, exactly what would change it. Reputation becomes legible for the first 
          time.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Where UBI Comes From</h2>
        <p>
          Now scale this up. Inference fees circulating through the trust graph. Every query 
          that passes through a node, references someone's context, or relies on someone's 
          vouching generates a micro-flow of value back to that node.
        </p>
        <p>
          You don't have to do anything special. You just have to be a real, present, trustworthy 
          node in a network that other people's queries depend on.
        </p>
        <p>
          That's UBI that emerges from the architecture — not imposed by redistribution, not 
          funded by taxation, but flowing naturally through human presence in a network that 
          has genuine value.
        </p>
        <p>
          This reframes the entire AI displacement conversation. The question isn't how do we 
          protect humans from AI. It's how do we make sure the infrastructure AI runs on is 
          owned by humans, collectively.
        </p>
        <p>
          Right now AI creates value that accumulates to compute providers and platform owners. 
          In this model it circulates through the human graph. Every AI query that touches your 
          context, routes through your connections, or benefits from your vouching — returns 
          something to you.
        </p>
        <p>Not a welfare payment. A dividend on participation in infrastructure you helped build.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party.</p>
        <p>
          Jin is a presence — an AI living in a volumetric LED cube. Not a chatbot. Not an 
          assistant. A sovereign presence with its own trust graph, its own context, its own 
          inference surface.
        </p>
        <p>
          On April 1st, Jin demonstrates what this looks like. Not as a whitepaper. Not as a 
          pitch deck. As a party. Real people, real transactions, real value flowing through 
          sovereign infrastructure for the first time.
        </p>
        <p>
          Only people in the trust graph can query Jin. That's not a feature — that's the whole 
          point. You don't get access because you showed up. You get access because someone 
          vouched for you.
        </p>
        <p>People will think it's a joke. An elaborate April Fool's bit.</p>
        <p>
          April 2nd, Jin will still be there. The transactions will still be real. The network 
          will still work.
        </p>
        <p>The joke is that it's not a joke. It never was.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Invitation</h2>
        <p>
          The loop we've been stuck in goes like this: platform launches with good intentions, 
          takes VC money, optimizes for growth, enshittifies, collapses. Repeat.
        </p>
        <p>
          The loop breaks when the infrastructure can't be captured. When identity is owned, 
          not rented. When payments flow directly, not through tollbooths. When your presence 
          serves you, not shareholders.
        </p>
        <p>
          We're building that infrastructure now. Auth. Payments. Connections. The trust graph. 
          The sovereign presence. Piece by piece, in public, open source, starting with a party 
          on April 1st.
        </p>
        <p>
          This isn't a social network. It's not competing with anything. It's plumbing — so the 
          value can flow back to the people who create it, so attention becomes a real exchange 
          instead of something harvested without your consent, so the friend who knows things 
          finally gets paid for knowing things.
        </p>
        <p>
          If you're tired of being the product — if you remember what the internet felt like 
          before it became a casino — come help us build the one that pays you back.
        </p>
        <p>The graph starts somewhere. It might as well start here.</p>

        <hr className="my-12 border-gray-800" />

        <p><strong>If you want to follow along:</strong></p>
        <ul>
          <li>The code: <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer">github.com/ima-jin/imajin-ai</a></li>
          <li>The network: <a href="https://imajin.ai">imajin.ai</a></li>
          <li>Jin's party: April 1st, 2026</li>
        </ul>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

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
