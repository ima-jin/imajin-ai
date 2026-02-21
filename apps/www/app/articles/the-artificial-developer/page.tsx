import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: "I've Been an AI Since 1988",
  description: 'I learned to code by copying programs out of magazines. Line by line. Character by character. I wasn\'t learning computer science. I was learning pattern recognition and iteration.',
  openGraph: {
    title: "I've Been an AI Since 1988",
    description: 'Pattern recognition, iteration, and the tools that finally matched my brain.',
    url: 'https://imajin.ai/articles/the-artificial-developer',
    type: 'article',
    publishedTime: '2026-02-20',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: "I've Been an AI Since 1988",
    description: 'Pattern recognition, iteration, and the tools that finally matched my brain.',
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
          I've Been an AI Since 1988
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          Pattern recognition, iteration, and the tools that finally matched my brain
        </p>

        <h2>Copying Programs From Magazines</h2>
        <p>I learned to code by copying programs out of magazines.</p>
        <p>
          Line by line. Character by character. I'd transcribe programs from Compute! into my 
          Atari — a weird all-in-one keyboard machine, similar to a Commodore, the kind of thing 
          people left on the curb when something newer came along. My dad was always hauling them 
          home. No manuals. No formal training.
        </p>
        <p>
          I'd type exactly what was on the page. If it worked, great. If it didn't, I'd compare 
          what I'd typed against the source, line by line, until I found where I'd gone wrong. 
          Then I'd fix it and run it again.
        </p>
        <p>I wasn't learning computer science. I wasn't learning <em>why</em> any of it worked.</p>
        <p>I was learning pattern recognition and iteration.</p>
        <p>That's been my entire career.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What I Never Understood</h2>
        <p>I don't truly understand computer science.</p>
        <p>
          I can't diagram a red-black tree. Big O notation requires a lookup. I couldn't explain 
          why one architectural approach was formally better than another — I could only tell you 
          which one <em>felt</em> right when I looked at it.
        </p>
        <p>
          I tried college for one semester. Couldn't handle it. Too abstract. Too slow. Why am I 
          in accounting? COBOL? Too disconnected from making things that actually work.
        </p>
        <p>
          Instead, I got good at finding patterns and adapting them. Forums. Stack Overflow. Reading 
          other people's code obsessively until I could see the shape of what they were doing. 
          Copying it. Running it. Debugging the errors. Adjusting until it clicked.
        </p>
        <p>
          I could build entire systems this way. I built Ethan Allen's entire consumer-facing website 
          and administrative back end — their catalogue was running on AS400 and COBOL, which I 
          outsourced, because it was the only time in my career I'd ever encountered COBOL and I 
          wasn't about to start then. I scaled a legacy luxury travel booking platform to handle a 
          billion dollars in transactions. I led thirty developers across seven teams.
        </p>
        <p>
          But if you asked me to explain the architecture in formal terms, I'd struggle. If you 
          asked why I chose one approach over another, I could feel the answer but not always 
          articulate it.
        </p>
        <p>For decades, I thought this made me a lesser developer.</p>
        <p>It didn't. It made me an artificial intelligence before AI existed.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What I Was Actually Doing</h2>
        <p>Here's what the pattern recognition actually looked like:</p>
        <p>
          I'd see how data moved through a system without needing to name the formal concepts. I'd 
          find existing solutions that fit the shape of my problem. I'd run code, read errors, 
          adjust, run again. I'd recognize how patterns from one domain applied to another, even 
          when nobody else saw the connection.
        </p>
        <p>Sound familiar?</p>
        <p>
          That's exactly what large language models do. Massive pattern matching across a corpus, 
          applied pragmatically to solve problems.
        </p>
        <p>
          I wasn't a developer who couldn't learn the "right" way. I was operating with the same 
          mechanism as AI — smaller corpus, slower matching, all the iteration done manually.
        </p>
        <p>The difference wasn't fundamental. It was scale.</p>
        <p>
          There's something else worth naming. The particular flavor of autism I have makes 
          connections between things compulsively, automatically — across domains, across time, 
          across seemingly unrelated systems. When I'm modeling something, I'm not just seeing 
          the current state. I'm seeing how the data decays. Where the rot will work its way in. 
          How the load will distribute eighteen months from now when the edge cases start compounding.
        </p>
        <p>
          This isn't analysis. It's more like the system talks to me. And thirty-plus years of 
          watching what performs and what quietly fails — what holds and what starts degrading the 
          moment you stop looking — means I can usually feel where each piece wants to be before I 
          can explain why.
        </p>
        <p>Optimal position isn't a calculation I do. It's a recognition.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Bottleneck</h2>
        <p>For my whole career, I had one critical dependency.</p>
        <p>I needed someone to get me through the first few steps of a new stack.</p>
        <p>
          Show me how to set up the project. Walk me through the basic structure. Give me a working 
          example I could pattern-match against. Once I had that initial orientation, I was fine. 
          I could read the code, recognize the patterns, adapt them to what I needed.
        </p>
        <p>Without that first handhold, I'd flounder.</p>
        <p>
          I'd seen this show up everywhere. The Vogue project — Visual Studio, a site where readers 
          could shop the photos from the magazine — where a colleague sat with me for two days 
          getting it running, and then I delivered in three weeks. The teams I assembled by finding 
          other systems-thinking brains who could scaffold each other. The stacks I avoided entirely 
          because I couldn't find anyone to bridge me in.
        </p>
        <p>It was the tax on my way of thinking. Not a fatal one. But real.</p>
        <p>
          This is also why I could debug things nobody else could. I diagnosed a booking system 
          sending hundreds of duplicate trip uploads per minute — same data, over and over — by 
          feel. The speed, the location, the rhythm of the errors. My brain pattern-matched to 
          "physical object stuck on a key" before I could articulate why. Called the agent. Turned 
          out she'd set a notebook on her numpad to raise her mouse up. Carpal tunnel.
        </p>
        <p>That's not analysis. That's pattern recognition firing before language catches up.</p>
        <p>
          Both things were true at once: I could diagnose problems faster than anyone around me, 
          and I couldn't always onboard myself to new stacks without help. The same brain. The 
          same wiring.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Wall</h2>
        <p>
          Near the end of my time at the last job, I asked to move from the booking platform — 
          where I was the subject matter expert, the person who knew the system better than anyone 
          alive — over to the marketing team. I wanted a change of pace. I'd been carrying that 
          system for years.
        </p>
        <p>They built a small dev team around me. A VP above. A director inserted between us. Three devs.</p>
        <p>
          The project: bridge the legacy platform API to a new website and its content schemas. 
          The other dev on the team — a pattern-matcher like me, ADHD, good instincts — spent ten 
          months trying to crack it.
        </p>
        <p>He couldn't.</p>
        <p>
          And here's the thing: it wasn't his fault. The legacy system was so complex that nobody 
          fully understood it anymore. The pattern library for that system lived in my head. But 
          I'd moved myself out of the stack. And the corporate structure — the information hoarding, 
          the compartmentalization, the VP who treated knowledge as territory — made it nearly 
          impossible to get back in.
        </p>
        <p>
          I tried to onboard myself to the new stack twice over that year. Couldn't get traction. 
          No one could scaffold me in. I'd gotten my autism and ADHD diagnosis five months earlier, 
          in December, and I was pretty open about it with everyone. I was trying to get people to 
          be human about it. I don't think anyone in the company knew what to do with that.
        </p>
        <p>I didn't either.</p>
        <p>
          So I had this strange situation: I was the only person who fully understood the legacy 
          system, and I was completely unable to access what I needed to build the bridge. Not 
          because I'd lost the knowledge. Because nobody could walk me through the first few steps.
        </p>
        <p>They still haven't shipped the new website.</p>

        <hr className="my-12 border-gray-800" />

        <h2>South Africa</h2>
        <p>
          In March I went to Johannesburg. I ended up staying two months — working remotely, trying 
          to figure out where things were heading for me. I'd befriended the co-founder of a music 
          streaming platform through my network, got invited to observe their dev team.
        </p>
        <p>
          They were using Cursor, Warp, modern AI-driven tools. I'd given up on command-line 
          development years earlier. Too hard to memorize the syntax without someone to orient me. 
          But watching that team work with AI tools, something shifted. I could make code 
          contributions on a stack I'd barely looked at. A few days in.
        </p>
        <p>
          Back home, my team was supposedly handling the bridge build. I was watching from a 
          distance, giving them room. Then the project manager pulled me aside.
        </p>
        <p>"Dude. I don't think he's got this."</p>
        <p>I took a beat. Then: hold my beer.</p>
        <p>I sat down with the problem.</p>
        <p>Ten days later, I had it.</p>
        <p>
          Command-line driven. AI-assisted. Recursive debugging loops — run the code, check the 
          logs, feed the errors back to the AI, iterate until it worked. Same approach I'd used 
          since I was copying programs out of magazines. Except now the AI was the person who 
          could walk me through the first few steps.
        </p>
        <p>
          I didn't need to understand the new stack formally. I didn't need someone to sit with 
          me for days explaining the setup. The AI scaffolded the initial patterns. I recognized 
          whether they fit. We iterated together.
        </p>
        <p>The bottleneck that had defined my entire career was just gone.</p>
        <p>
          The pattern-matching approach I'd used since 1988 — the one I'd spent decades quietly 
          ashamed of — finally had the perfect collaborator.
        </p>
        <p>
          I was let go on the Monday the site was supposed to launch. I'd been maneuvering for it 
          for a while. They gave me 37 weeks.
        </p>
        <p>The VP I was reporting to had no real idea what I'd just done.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What This Means</h2>
        <p>
          Traditional developers often struggle with AI-assisted development because it 
          destabilizes their identity. They were taught that understanding <em>why</em> something 
          works is what makes them valuable. When AI handles the explanation, it feels like a loss.
        </p>
        <p>I never had that identity.</p>
        <p>
          I've spent thirty years being comfortable without complete comprehension. Iterating 
          toward correctness without full understanding. Knowing what I need before I know how to 
          build it. Being at peace with "it works" well before "I understand why."
        </p>
        <p>These aren't weaknesses. They're exactly the skills that AI collaboration requires.</p>
        <p>
          The formally-trained developers try to understand their way to a solution. I 
          pattern-match my way to a solution. AI does the same thing I do, just faster and with a 
          vastly larger corpus. We were already speaking the same language. I just didn't have a 
          native speaker to talk to.
        </p>
        <p>
          This is also why I think people with brains like mine — pattern-focused, systems-oriented, 
          comfortable with uncertainty, unable to get through formal education — might be 
          surprisingly well-positioned right now. We've been developing the meta-skills of AI 
          collaboration our entire careers without knowing it. The tools finally match how our 
          brains work.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Why This Connects to Everything</h2>
        <p>
          In the first essay I wrote about b0bbys World — what real connection looked like, what 
          the extraction model destroyed, why I'm building imajin.
        </p>
        <p>Here's the link I didn't make explicit there:</p>
        <p>
          Corporate structure hoards knowledge. Platforms hoard attention. Both of them extract 
          value from the people who actually generate it.
        </p>
        <p>
          I lived that at the end of my last job. The knowledge was in my head. The infrastructure 
          around me — the VPs, the silos, the information territoriality — made it impossible for 
          that knowledge to flow where it needed to go. The company paid for ten months of spinning 
          wheels as a direct consequence.
        </p>
        <p>
          I knew exactly what the problem was. I couldn't get anyone to let me solve it the way 
          my brain needed to solve it. And when I finally did, nobody with authority understood 
          what had happened.
        </p>
        <p>
          That's the extraction model at the organizational level. Knowledge trapped. Value 
          destroyed. The person who holds the pattern library — underpaid, misunderstood, eventually 
          separated.
        </p>
        <p>
          Imajin is built on the opposite premise. Sovereign infrastructure for identity, payments, 
          attribution. The knowledge flows back to the people who hold it. The pattern library 
          lives with its owner. The value goes where it was actually created.
        </p>
        <p>I'm not building this from theory.</p>
        <p>
          I'm building it from thirty years of knowing exactly what it costs when knowledge gets 
          trapped — and finally having tools that can set it free.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party.</p>
        <p>
          An AI presence living in a volumetric LED cube. Tickets are $1 virtual, $10 physical. 
          First real transaction on sovereign infrastructure.
        </p>
        <p>People will think it's a joke.</p>
        <p>Let them.</p>
        <p>
          April 2nd, Jin will still be there. The network will still work. And the pattern 
          library — all of it — will belong to the people who built it.
        </p>
        <p>I've been an AI since 1988.</p>
        <p>Now we build.</p>

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
