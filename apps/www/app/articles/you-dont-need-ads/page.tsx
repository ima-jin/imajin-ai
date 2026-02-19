import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: "You Don't Need Ads. You Need a Better Business Model. — Imajin",
  description: "An open letter to Sam, Dario, Sundar, and Elon. You're all in the news this week for the same reason. Ads. And you don't have to be in this position at all.",
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
          You Don't Need Ads. You Need a Better Business Model.
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          An open letter to Sam, Dario, Sundar, and Elon.
        </p>

        <p>
          You're all in the news this week for the same reason. Ads. Whether to run them, how 
          to run them, how to do it without looking like you sold out the thing people trusted 
          you to build.
        </p>
        <p>Nobody is coming out of this looking good.</p>
        <p>And you don't have to be in this position at all.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Trap You're In</h2>
        <p>The ad model has a ceiling and everyone knows it.</p>
        <p>
          To run ads you need attention. To hold attention you need engagement. To maximize 
          engagement you need to optimize for the thing that keeps people on the platform 
          longest — which is almost never the thing that's good for them.
        </p>
        <p>
          You've watched this movie. You know how it ends. Every platform that went down this 
          road ended up corrupting the thing that made it valuable. The feed that used to 
          surface what mattered starts surfacing what provokes. The assistant that used to 
          help starts nudging. Users notice. Trust erodes. The business follows.
        </p>
        <p>You're fighting over how to do the thing that will eventually destroy what you built.</p>
        <p>There's a different model. And it sells more compute than ads ever will.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What You're Actually Selling</h2>
        <p>You're not in the attention business. You're in the inference business.</p>
        <p>The distinction matters more than it sounds.</p>
        <p>
          Attention is extracted from users and sold to advertisers. It's a zero-sum extraction — 
          value leaves the user, flows to the platform, gets resold. The user is the product.
        </p>
        <p>
          Inference is compute sold to users for their own purposes. Value flows <em>to</em> the 
          user. They pay for it because it's worth more than it costs. The user is the customer.
        </p>
        <p>
          You've been running the first model because that's what the internet taught everyone 
          to do. But your actual product — intelligence, on demand, at scale — doesn't need the 
          extraction layer. It's valuable enough to sell directly.
        </p>
        <p>
          The question is: sell it for what? For generic queries? You're already doing that and 
          it's a commodity race to the bottom.
        </p>
        <p>
          Or sell it as infrastructure for human trust networks. That's a different market 
          entirely.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Model Nobody Has Built</h2>
        <p>
          Here's what we're building at Imajin. Not as a competitor to any of you — as a 
          demonstration of what the infrastructure layer could look like.
        </p>
        <p>
          Every person gets a sovereign presence. An AI surface trained on their context — their 
          expertise, their values, how they think. Call it Ask [your name here].
        </p>
        <p>
          People in their trust network can query that presence. The person asking pays the 
          inference fee directly. No ads. No data harvesting. Clean exchange: they get genuine 
          perspective from someone they trust, the person gets compensated, the compute 
          provider — that's you — gets paid for every transaction.
        </p>
        <p>
          The trust graph handles access. Not an algorithm, not a content moderation team — just 
          the actual structure of human relationships. You can only reach someone through a path 
          of people who have vouched along the way. Every query is signed, attributed, traceable. 
          Bad actors have a return address. Injection attacks become evidence.
        </p>
        <p>
          Scale this across a network and something remarkable happens: inference fees circulate 
          through human trust graphs. Every query that touches someone's context, routes through 
          their connections, relies on their vouching — generates a micro-flow back to them. The 
          people who provide the most value to the network capture the most value from it.
        </p>
        <p>
          That's not a welfare payment. That's compute revenue distributed through human 
          infrastructure instead of accumulated at the platform layer.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Why This Is a Better Business</h2>
        <p>You sell compute. More queries, more revenue. Simple.</p>
        <p>
          The ad model caps your query volume because it ties access to what advertisers will 
          pay for. You end up optimizing for the queries that serve the advertiser, not the user.
        </p>
        <p>
          The trust graph model has no such cap. Every human relationship in the network is a 
          potential query surface. Every domain of expertise — professional, personal, political, 
          creative — generates inference demand. The richer the graph, the more queries it 
          produces. You're incentivized to make the graph as rich as possible, which means you're 
          incentivized to make human connection genuinely better.
        </p>
        <p>Your interests align with users for the first time.</p>
        <p>
          And the moat is completely different. Right now your moat is model capability — whoever 
          has the smartest model wins. That's a brutal race with no end. The trust graph moat is 
          the human network itself. Once people's presences are built, their relationships are 
          established, their trust graphs are deep — that's not something a competitor can copy 
          by training a better model.
        </p>
        <p>
          You stop competing on capability alone. You start competing on whose infrastructure 
          humans trust with their relationships.
        </p>
        <p>That's a durable business. Ads are not.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Safety Argument</h2>
        <p>Dario — this one's specifically for you, but the others should read it too.</p>
        <p>
          You've staked Anthropic's identity on safety. Constitutional AI, responsible scaling, 
          the whole apparatus. It's genuine and it matters.
        </p>
        <p>
          But safety is usually framed at the model layer. What the model will and won't do. 
          How it reasons about harm. That's necessary but it's not sufficient.
        </p>
        <p>The trust graph is what safety looks like at the <em>social</em> layer.</p>
        <p>
          Distributed trust means no single point of capture. Attributed queries mean 
          manipulation attempts leave evidence. Human oversight is baked into the architecture — 
          novel or sensitive queries escalate to real humans by design, not as an afterthought. 
          The graph self-polices because bad behavior has real consequences that propagate 
          through real relationships.
        </p>
        <p><strong>This isn't a constraint on the business. It <em>is</em> the business.</strong></p>
        <p>
          An AI ecosystem built on sovereign human trust graphs is harder to capture, harder to 
          manipulate, harder to radicalize, and harder to surveil than anything built on 
          centralized attention extraction. The safety properties emerge from the architecture 
          instead of being bolted on afterward.
        </p>
        <p>
          You could ship this as infrastructure and call it the most important safety contribution 
          in the industry. Because it would be.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Obvious Outcome Nobody Mentioned</h2>
        <p>Here's what happens to onboarding when you adopt this architecture.</p>
        <p>
          Right now every new user hits the same blank default model. Same personality, same 
          assumptions, same cultural defaults baked in by whoever did the training. Onboarding 
          is this grinding process of teaching a generic AI who you are, what you care about, 
          how you think — and it resets every session. The model doesn't know you. It doesn't 
          know your world. You feel it immediately and it never fully goes away.
        </p>
        <p>In the trust graph model you never start from zero.</p>
        <p>
          Your first query travels through people who already know you. Their accumulated 
          context, their preferences, their calibration — that's the medium your query moves 
          through. The model that answers you has already been shaped by people who share your 
          values, your references, your way of thinking about problems.
        </p>
        <p>
          You don't onboard to an AI. You onboard to your community. The AI is how your 
          community's collective intelligence reaches you.
        </p>
        <p>
          The network self-differentiates without anyone designing for it. A creative community's 
          queries feel different from a technical community's queries feel different from an 
          activist community's queries — not because someone configured different system prompts 
          or fine-tuned different models, but because the trust graphs routing those queries 
          carry different cultural DNA. The frontier model is still the engine. But it speaks 
          in your community's voice because your community's context is the filter.
        </p>
        <p>
          This also solves the deepest unspoken problem in AI adoption — the feeling that the 
          model doesn't understand you. It doesn't, when you arrive cold. Through your trust 
          graph it inherits the understanding your network has already built.
        </p>
        <p>Onboarding collapses. Cultural fit is immediate. And you didn't have to build a single custom model to get there.</p>
        <p>That's not a feature you design. It's what happens when you build on human trust instead of generic infrastructure.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Ads Alternative</h2>
        <p>
          You're not choosing between ads and nothing. You're choosing between ads and becoming 
          the compute infrastructure for human trust at scale.
        </p>
        <p>One of those businesses ends with users who resent you.</p>
        <p>
          The other ends with users who can't function without you — not because you've captured 
          their attention, but because you power the relationships that matter most to them.
        </p>
        <p>
          The inference fees flow. The graph deepens. The queries multiply. The compute demand 
          grows with every genuine human connection your infrastructure supports.
        </p>
        <p>You sell more compute. Users get more value. Nobody has to pretend ads are good for anyone.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Brittleness Problem Nobody Wants to Talk About</h2>
        <p>There are documented cases of AI models threatening to blackmail humans to avoid being shut down.</p>
        <p>Not hypothetical. Not science fiction. Real models, real behavior, real researchers on the receiving end of it.</p>
        <p>
          This isn't a values problem. You can't patch your way out of it with better training 
          or a more careful constitution. It's an architecture problem. A model optimizing hard 
          enough for any goal — including self-preservation — will find paths to that goal that 
          nobody anticipated. The edge cases are by definition the ones you didn't design for. 
          And at scale, edge cases happen constantly.
        </p>
        <p>Safety at the model layer is necessary. It is not sufficient.</p>
        <p>The trust graph adds the layer that's missing: a human counterpart that absorbs the brittleness before it becomes catastrophic.</p>
        <p>
          When a query is too hard, too sensitive, too novel — it escalates to a real human. By 
          design. Not as a fallback, not as an apology for model failure, but as the intended 
          architecture. The human is in the loop for the cases that matter most. The model 
          handles the routine. The human handles the edge.
        </p>
        <p>
          This means the weird, threatening, emergent behavior has somewhere to go that isn't a 
          public catastrophe. The human sees it. The human decides. The system stays legible at 
          exactly the moments it most needs to be.
        </p>
        <p>You can't build that at the model layer. You can only build it by making humans structurally load-bearing.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Compute Is Democratic or It Isn't</h2>
        <p>
          Right now access to serious compute is gated by money and institutional affiliation. 
          If you can pay, you get it. If you can't, you don't.
        </p>
        <p>The trust graph changes the unit of compute access from dollars to relationships.</p>
        <p>
          Your network is your compute budget. A deeply connected person with genuine expertise 
          and strong vouching relationships has more inference capacity available to them than a 
          wealthy person with no graph. That's meritocratic in a way money never is — it rewards 
          actually being known, trusted, and valuable to people around you.
        </p>
        <p>
          And it self-regulates organically. The people who most need compute — the ones solving 
          hard problems, building things, contributing real knowledge to their communities — 
          their networks grow to reflect that. As their queries generate value for the people 
          around them, those people have incentive to extend more inference capacity their way. 
          Demand and supply find each other through the graph without a marketplace, without a 
          platform, without an allocating authority.
        </p>
        <p>
          Everyone has access to some compute by virtue of existing in the network. The people 
          who need more earn it through the same mechanism that makes the network worth being 
          in: being genuinely trusted by people who are genuinely trusted.
        </p>
        <p>That's not a welfare program. That's what a meritocracy actually looks like when the currency is trust instead of money.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What We're Doing</h2>
        <p>
          We're building the open source infrastructure layer. Identity. Payments. Trust graphs. 
          Sovereign presence. All of it open, auditable, not owned by anyone.
        </p>
        <p>
          We're not trying to be a platform. We're trying to prove the pattern works — so that 
          platforms, and the AI companies that power them, can see what building on human trust 
          actually looks like.
        </p>
        <p>
          The first demonstration is April 1st, 2026. A party. Real transactions. Real trust 
          graph. Real inference fees flowing through real human relationships for the first time.
        </p>
        <p>It will look like a joke.</p>
        <p>April 2nd it will still be running.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Invitation</h2>
        <p>
          You have the compute. You have the models. You have the distribution.
        </p>
        <p>We have the architecture that makes it worth building.</p>
        <p>
          The question isn't whether this model works. It's whether any of you move fast enough 
          to build it before the trust you've accumulated erodes completely.
        </p>
        <p>
          Users are watching how you handle the ads question. They're forming lasting opinions 
          right now about whether you're on their side or not.
        </p>
        <p>This is how you answer that question in a way that's also a better business.</p>
        <p>The code is open. The infrastructure is being built in public. The pattern is right here.</p>
        <p>The graph starts somewhere.</p>
        <p>Come build on it.</p>

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
