import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Burn',
  description: 'I want to tell you about the six weeks after they let me go. Not the triumphant version. The complete version is: I nearly killed myself.',
  openGraph: {
    title: 'The Burn',
    description: 'The crash is not proof you\'re serious. It\'s proof the architecture is wrong. The slower path got there faster.',
    url: 'https://imajin.ai/articles/the-burn',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'The Burn',
    description: 'The crash is not proof you\'re serious. It\'s proof the architecture is wrong. The slower path got there faster.',
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
          The Burn
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          The slower path got there faster
        </p>

        <h2>What It Actually Costs</h2>
        <p>I want to tell you about the six weeks after they let me go.</p>
        <p>
          Not the triumphant version. Not the "I delivered the bridge in ten days and walked out with 
          the pattern library and started building the future" version. That version is true but it's 
          incomplete in a way that would be dishonest to leave uncorrected.
        </p>
        <p>The complete version is: I nearly killed myself.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Activation Sequence</h2>
        <p>To understand the burn you have to understand what came before it.</p>
        <p>
          Eight months before they fired me, I went to South Africa. Garden Route first — a prehistoric 
          dune outside Sedgefield, a shamanic medicine weekend at Cloud 9 Villa, ~80 people, five days. 
          Then three weeks in Johannesburg with Geordie and the WeR1 music streaming team. Then ten days 
          in Cape Town, embedded with the Red Telephone Kollective in their shipping container studios 
          in the old Cape Town yards, building and preparing everything for AfrikaBurn.
        </p>
        <p>I want to stay on the shipping containers for a moment because they matter to what comes later.</p>
        <p>
          The Red Telephone Kollective and their Swiss friends from Enos' Nookie camp had built 
          sovereign nodes in those containers. Each one owned and operated by a different crew. All of 
          them part of shared infrastructure. Different music, different aesthetics, different 
          communities — connected by proximity and shared purpose and the fact that none of them had a 
          landlord extracting rent from the culture they were making.
        </p>
        <p>I was living inside the thing I was about to build digitally. I didn't know that yet.</p>
        <p>
          Then AfrikaBurn. April 28 through May 4, 2025. The Karoo desert. Enos' Nookie camp, named 
          after Enos the space monkey — first creature to survive re-entry from space. The camp had two 
          chambers: inside, low-volume, intimate, conversation-level; outside, a massive sound system 
          for ecstatic release. The architecture served both the quiet and the loud. Neither 
          compromised the other.
        </p>
        <p>
          Two months in South Africa. The dune. Joburg and the AI tools I'd never seen used that way 
          before. The shipping containers. The desert. AfrikaBurn's 11th principle: <em>each one teach 
          one</em> — directed specifically at people whose education was stolen. Not an abstract value 
          statement. A design principle with real stakes.
        </p>
        <p>I banked all of it. The whole activation sequence.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Bridge</h2>
        <p>
          While I was in Joburg watching the WeR1 team work with Cursor and Warp — tools I'd never 
          encountered at my corporate job where I'd been buried in a legacy system for years — 
          something dissolved.
        </p>
        <p>
          The bottleneck that had defined my entire career. The inability to onboard myself to a new 
          stack without someone to bridge me in. Watching that team work, I was making meaningful code 
          contributions within days on a stack I'd never been comfortable with. The AI handled the 
          first steps every time. The pattern matching could just run.
        </p>
        <p>
          I came home to Toronto around May 12th. The project manager's message was waiting: <em>"Dude. 
          I don't think he's got this."</em>
        </p>
        <p>
          The bridge problem. Ten months my colleague had been spinning on it. I was his manager. The 
          knowledge was mine and the job was mine — I was supposed to be the route through. I just 
          couldn't get it through.
        </p>
        <p>
          The problem was the stack. PHP/Laravel. I couldn't get traction in it. And without being able 
          to write the code — to speak in my native language, to build the pattern and let him 
          duplicate it — I had no way to transmit the model. That's how I've always worked. I get the 
          foundation going, figure out the optimal patterns, build the thing, and other devs duplicate 
          it. The knowledge flows through working code, not through whiteboards or Jira tickets or 
          abstract object model discussions. Those tools make the job feel like a grind and produce 
          nothing I can actually use.
        </p>
        <p>
          I tried other ways to communicate the model. Couldn't tolerate the tools. Gave up. Watched 
          ten months of spinning wheels as a direct consequence.
        </p>
        <p>
          Then South Africa. Joburg. Watching the WeR1 team work with AI tools I'd never seen used that 
          way. And something dissolved — not just the general onboarding bottleneck, but specifically 
          the thing that had crippled me in stacks I couldn't get my hands into. The AI could walk me 
          through the first steps in any stack. The pattern could flow again.
        </p>
        <p>I came home and sat down with the bridge problem.</p>
        <p>
          Ten days. Command-line driven, AI-assisted. The same recursive loop I'd been running since I 
          was copying programs out of <em>Compute!</em> magazine — run the code, read the errors, feed 
          them back, iterate until it clicks. Except now the AI was the person who could walk me 
          through the first steps in a stack that had previously stopped me cold.
        </p>
        <p>I delivered the bridge.</p>
        <p>
          They let me go on May 22nd. The Monday the new site was supposed to launch. I'd been 
          maneuvering for it. Thirty-seven weeks severance. The VP who signed the paperwork had no real 
          idea what had happened in the ten days prior.
        </p>
        <p>The knowledge that had lived in my head for a decade walked out the door with me.</p>
        <p>They still haven't shipped the website.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Detonation</h2>
        <p>The Monday they let me go I went home and opened my laptop.</p>
        <p>
          Thirty-seven weeks of severance. A decade of accumulated pattern library in my head. The 
          sudden terrifying freedom of no structure, no standup, no VP to manage around. Just: the 
          problem, the tools, and me.
        </p>
        <p>
          I rewrote the internal CLI tool I'd been building at Kensington — the one that cracked the 
          bridge problem — from scratch. My own code now. imajin-cli. Three weeks. Fourteen to sixteen 
          hours a day.
        </p>
        <p>
          The imajin-cli repo has 99 commits in three weeks. That's the artifact. That's what the burn 
          looks like from the outside — clean commits, phase completions, architecture decisions, a 
          working system emerging from nothing.
        </p>
        <p>
          From the inside it was something else. All the energy I'd banked across two months in South 
          Africa — the dune, the Joburg team, the Cape Town containers, AfrikaBurn — expended in a 
          single post-severance detonation. The tank emptied completely. Six weeks total, when you 
          include the bridge solve in Toronto before they fired me.
        </p>
        <p>
          My brain was on fire in the way that feels like productivity until it doesn't. Until the 
          circuits start misfiring. Until you're making decisions at 2am that you'll spend weeks 
          untangling. Until the thing you're building starts to feel less like creation and more like a 
          controlled detonation you're standing in the middle of.
        </p>
        <p>I fried my brain.</p>
        <p>
          That's not a metaphor. That's what happened. The neurodivergent brain that had spent thirty 
          years being told it was broken, that had finally found its native language in the AI tools, 
          that had a decade of compressed energy suddenly released with no constraint — it ran until it 
          couldn't run anymore.
        </p>
        <p>And then I had to leave.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Drive</h2>
        <p>
          I won't fly when I'm traveling with my lights. The fixtures are built with the intention they 
          eventually live permanently somewhere — they go with me, in a vehicle I drive.
        </p>
        <p>
          Around June 13th I drove from Toronto to Washington State. Approximately 45 hours straight. 
          The same brain that had pattern-matched through decades of dev work, processed the entire 
          activation sequence of South Africa in real time, and solved a ten-month engineering problem 
          in ten days — drove like it was a recursive loop with no termination condition.
        </p>
        <p>
          Meadow Festival in Washington State. June 20th through 23rd. A 150-person event where nearly 
          every attendee is a DJ. Micro-culture in formation — fragile and intentional, still figuring 
          out how to invite new people in without hardening into a brand. A petri dish, not a product.
        </p>
        <p>
          Then the drive back. Vancouver, north around Lake Superior, back to Toronto. Approximately 37 
          hours. The long way home.
        </p>
        <p>
          Then Boom Festival in Portugal. July 17th through 24th. My seventh time. Whole neighbourhoods 
          forming and dissolving. An artist economy, self-sustaining. Toddlers with ear protectors. 
          70-year-olds grinning. Families sharing tea next to stages. The daily reset: all stages off 
          simultaneously, the whole festival moving to the market. Culture that includes all 
          generations isn't escape — it's the village.
        </p>
        <p>Then Berlin. Sisyphos. Late July through mid-August.</p>
        <p>Then home. August 2025.</p>
        <p>
          The activation sequence complete. Two continents. Eight months. The AI collaboration 
          bottleneck dissolved. The imajin stack taking shape. The burn survived.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>What Home Has Been</h2>
        <p>This is the part nobody writes about because it doesn't make a good story.</p>
        <p>Home has been: slow. Deliberately, carefully, intentionally slow.</p>
        <p>
          Coffee in the morning. Some reading. Code for a few hours. Stop when it stops feeling good. 
          Walk. Write when the writing comes. Sleep at a reasonable hour.
        </p>
        <p>That's it. That's the whole schedule.</p>
        <p>
          For someone who spent thirty years in the burn model — the sprint, the crash, the recovery, 
          the next sprint — this felt for a long time like failure. Like I should be doing more. Moving 
          faster. The April 1st deadline is real. The mortgage is real. The $45 a day in inference 
          costs is real. Everything argues for urgency.
        </p>
        <p>
          But I've been to the end of urgency. I know what's there. The 99 commits and the fried brain 
          and the 45-hour drive and the need to loop through two continents before I could be in my own 
          body again.
        </p>
        <p>
          The slow pace isn't laziness. It's information. My previous stretches lasted ten days, 
          fourteen days maximum before the crash. This one has been going since August. Six months. 
          Every day. Without a crash.
        </p>
        <p>
          The AI handles the bottleneck that used to burn the most energy. The pattern matching runs on 
          its own. What's left for me is the part that was always mine: judgment. Curation. Knowing 
          where the system wants to be before I can articulate why.
        </p>
        <p>That part doesn't deplete the same way. It actually gets better with rest.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What The Crash Taught Me</h2>
        <p>You can't build a network for human flourishing by destroying yourself to prove it's possible.</p>
        <p>
          The burn was the extraction model eating the alternative infrastructure from the inside. The 
          voice that says do more, move faster, prove it now — that's the same voice that runs the 
          standup and the all-hands and the performance review. It followed me home. It followed me 
          into the thing I was supposedly building to get away from it.
        </p>
        <p>
          The reset — the drive, the desert, Boom, Berlin, six months of deliberate slow — that was 
          finding the actual architecture. The one that doesn't require destroying yourself to keep running.
        </p>
        <p>
          This is what I want to say to everyone who builds like I build: the crash is not proof you're 
          serious. It's proof the architecture is wrong.
        </p>
        <p>
          The right architecture sustains you. The right tools reduce cognitive load instead of letting 
          you run the same broken pattern faster. The right rhythm produces more over time than the 
          burn, because the burn has a body count and the body is yours.
        </p>
        <p>
          Four live services deployed this afternoon. Six essays posted. A party on April 1st that will 
          still be running on April 2nd.
        </p>
        <p>The slower path got there faster.</p>

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
