import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Guild — Imajin',
  description: 'The invitation to operators. What a sysop actually was, and what an operator is now. The sysop role made available to everyone.',
  openGraph: {
    title: 'The Guild',
    description: 'The invitation to operators. The sysop role made available to everyone.',
    url: 'https://imajin.ai/articles/the-guild',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Guild</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">The invitation to operators</p>

        <h2>What a Sysop Actually Was</h2>

        <p>Before I tell you what an operator is, let me tell you what a sysop was.</p>

        <p>Not technically. Everyone knows the technical part — system operator, the person who ran the BBS, maintained the hardware, kept the lights on. That's the job description. That's not what a sysop was.</p>

        <p>A sysop was the person who decided what kind of room it would be.</p>

        <p>Happy Boat was weird. That was Seth's decision. Not a feature — a choice. He could have run a clean, general-purpose board. Instead he ran something strange and specific and alive, and the people who found it and stayed were the people who wanted exactly that.</p>

        <p>b0bbys World was a music hub. That was my decision. The demoscene. Tracker music. MAZURkA first, then Chill Productions. I cared about that music and I built a place for people who cared about it too. The scarcity — three nodes, three people at a time — wasn't a limitation I was working around. It was part of what made the room what it was.</p>

        <p>The technology was almost incidental. The 386, the modems, the phone lines — that was the infrastructure. The sysop was the person who decided what happened on top of it.</p>

        <p>When the BBS networks dissolved into platforms, that role disappeared. Not because the technology made it unnecessary. Because the platforms couldn't monetize it. A human being making curatorial decisions about a room — caring about the room, being responsible for the room — that doesn't scale. You can't replace it with an algorithm without losing the thing that made it valuable.</p>

        <p>So they replaced it with an algorithm.</p>

        <p>And we got what we got.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Sysop Was Technical. Operator Is Curatorial.</h2>

        <p>Sysop was a technical role with social consequences. Operator is a social role with technical infrastructure underneath it.</p>

        <p>The difference is what you're actually responsible for. The sysop kept the board alive. The operator curates connection. One is maintenance. The other is a practice.</p>

        <p>Operator is like a modern word for sysop — except more involved. Because the infrastructure is no longer the hard part. The hard part is what it always was: deciding what kind of room it is, who belongs in it, what happens when it goes wrong.</p>

        <p>You're not just keeping the lights on. You're deciding what kind of light it is. Who gets to stand in it. The craft is the curation of connection. And curation of connection is actually harder than anything technical. You can learn the stack. You can't learn caring about the room. You either feel the responsibility or you don't.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The CS People Are the Sysops</h2>

        <p>Here's something nobody is saying to the engineers watching AI eat their employment category.</p>

        <p>You're not obsolete. You're the sysop.</p>

        <p>The technical barrier to running infrastructure has been collapsing for years and AI just finished the job. The purely technical role is under pressure. That's real.</p>

        <p>But the sysop role — the person who understands systems deeply enough to know where they want to be, who can feel when something is wrong before they can articulate why, who can bridge between the community and the capability — that role isn't under pressure. That role is newly essential. The AI handles the routine. The sysop handles the edge.</p>

        <p>The staffing agency took your credential and rented you out at a margin. The guild gives you a node. A room that is yours to curate. A community that knows your name not because you're their account manager but because you built something they depend on.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Wrong Filter</h2>

        <p>The credential economy selects for the wrong people.</p>

        <p>The CS degree, the bootcamp certificate — these filters were designed to answer: can this person build the thing? They're mediocre at even that question, because the people best at building are often exactly the people who couldn't tolerate the institutions that issue credentials.</p>

        <p>But they're completely useless at answering the question that matters for an operator: can this person be trusted to run something people depend on?</p>

        <p>The operator isn't credentialed by a certificate. They're credentialed by their relationships. Who vouched for them. Who depends on their node. What happens to their standing when they make a bad call.</p>

        <p>The credential was always the wrong filter. The trust graph is the right one.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party. Come join the guild.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
