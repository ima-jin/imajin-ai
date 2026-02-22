import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'I Need Help',
  description: 'I have spent nineteen essays proving I know what I\'m talking about. Now I need to say the thing founders aren\'t supposed to say. I need help.',
  openGraph: {
    title: 'I Need Help',
    description: 'The honest move — the on-brand move — is to say that out loud.',
    url: 'https://imajin.ai/articles/i-need-help',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'I Need Help',
    description: 'The honest move — the on-brand move — is to say that out loud.',
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
          I Need Help
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          The honest move — the on-brand move — is to say that out loud
        </p>

        <p>I have spent nineteen essays proving I know what I'm talking about.</p>
        <p>Now I need to say the thing founders aren't supposed to say.</p>
        <p>I need help.</p>

        <hr className="my-12 border-gray-800" />

        <p>
          Not as a rhetorical flourish. Not as a humble-brag. Not as a growth-hack dressed 
          up in vulnerability.
        </p>
        <p>
          I mean it literally. The weight of holding this whole framework in my head, 
          alone, for months, is crushing me. I have been doing what connectors do — 
          maintaining every thread, tracking every dependency, holding the whole shape 
          simultaneously — but without the mesh I'm describing. Still running it manually. 
          Still a single point of failure.
        </p>
        <p>I am the bottleneck I've been writing about.</p>
        <p>
          And I'm writing this essay because the honest move — the on-brand move, the 
          imajin move — is to say that out loud instead of performing certainty until the 
          money shows up.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Myth I'm Not Playing</h2>
        <p>
          The founding myth of the current moment goes like this: one founder, one AI, one 
          laptop, world domination. The tools are so good now that you don't need a team. 
          You're the team.
        </p>
        <p>
          There's truth in it. I have shipped more in the last several months, alone, than 
          teams of ten managed in years I've worked in. The AI collaboration bottleneck 
          dissolved and I became genuinely dangerous. I built imajin-cli in three weeks at 
          fourteen hours a day. The code is there. The architecture is there. The arguments 
          are laid out across nineteen essays, in sequence, with receipts.
        </p>
        <p>
          But here's what the myth leaves out: even the mythological one-person founder has 
          a support structure. They have investors who believe in them. They have an early 
          community who shows up. They have at least one other person who can hold the 
          whole vision when the founder's brain is offline.
        </p>
        <p>I have been trying to be the node and the network simultaneously.</p>
        <p>
          That's not sustainable. And more importantly — it's not the argument I've been 
          making. The argument is that no single node should be the single point of failure. 
          The argument is that the load should be distributed. The argument is that the 
          people who are always load-bearing should finally have infrastructure that sees 
          and compensates that.
        </p>
        <p>I am about to fail my own thesis.</p>
        <p>So I'm asking.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What I Actually Need</h2>
        <p>
          <strong>Financial help.</strong> Not venture capital with control strings 
          attached. The 37 weeks of severance have funded a remarkable amount of thinking 
          and building, but I am not independently wealthy and runway is finite. I need 
          people who believe in what they've just read across nineteen essays to become 
          patrons, angels, early backers — whatever shape makes sense for where they are. 
          I'm not asking for millions. I'm asking for enough runway to get Jin's party 
          running and the first real operator nodes live.
        </p>
        <p>
          <strong>Dev help.</strong> I am a strong developer. I am not a team. There are 
          specific layers of this stack — the federation protocol, the DID implementation, 
          the payment rail integration, the mobile presence layer — that need builders who 
          are not me. Not just coders for hire. People who read The Utility and felt 
          something click. People who have been trying to build something like this from a 
          different angle and want to work on it together. If you are that person, I want 
          to talk to you yesterday.
        </p>
        <p>
          <strong>Other brains.</strong> The trust graph argument, the .fair protocol, the 
          operator network model, the economics of inference fees circulating through human 
          infrastructure — I have been thinking about these things mostly alone, with an AI 
          as my sounding board. That's been extraordinary and insufficient. I need people 
          who can punch holes in the architecture. Who can see what I'm missing from their 
          angle. Economists. Cryptographers. Protocol designers. Community builders who 
          have been running nodes of their own and know where the problems actually live.
        </p>
        <p>
          <strong>Community.</strong> People who read these essays and recognized something. 
          People who were on the BBSes and felt the loss. People who have been building 
          events and communities and creative infrastructure for years and kept hitting the 
          same extractive ceiling. People who looked at the current internet and thought: 
          this is not what it was supposed to be. People who want to be early in something 
          that is trying to fix that at the architecture level, not the feature level.
        </p>
        <p>
          If you are any of these people — I am not hard to find. I am at the links at the 
          bottom of every essay. I am building in public. I am, apparently, writing 
          manifestos.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Why This Is the Right Essay to End On</h2>
        <p>
          Because the whole argument is that the internet should be a place where you can 
          ask for what you need and have it find the right people.
        </p>
        <p>
          Not through an algorithm that serves your request to whoever paid for placement. 
          Through a trust graph that routes it to the people who are genuinely the right 
          fit.
        </p>
        <p>
          I don't have that infrastructure yet. That's the thing I'm building. But I can 
          model the behavior in the meantime.
        </p>
        <p>So here is the ask, signed, attributed, with a return address:</p>
        <p>
          I am Ryan VETEZE, known as b0b. I have been building connective infrastructure 
          since 1988. I ran a BBS called b0bby's World. I have organized fourteen summers 
          of a community called Summer Camp. I have thirty years of pattern library in my 
          head and finally the tools to make it legible and the architecture to make it 
          buildable. I spent three weeks burning out my brain writing imajin-cli on 
          severance pay and five events on two continents making sure I understood what I 
          was trying to build before I tried to build it.
        </p>
        <p>I am not a first-time founder with a pitch deck.</p>
        <p>
          I am someone who has been right about this for thirty years and finally has the 
          tools to prove it.
        </p>
        <p>And I can't do it alone.</p>
        <p>
          If you've read all of this — all twenty of these essays, or even five of them, 
          or even this one — you have enough context to know whether you're the kind of 
          person who belongs in this.
        </p>
        <p>Come in.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai aka b0b</p>

        <hr className="my-12 border-gray-800" />

        <p><strong>If you want to follow along:</strong></p>
        <ul>
          <li>The code: <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer">github.com/ima-jin/imajin-ai</a></li>
          <li>The network: <a href="https://imajin.ai">imajin.ai</a></li>
          <li>Jin's party: April 1st, 2026</li>
          <li>To reach me directly: you know how.</li>
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
