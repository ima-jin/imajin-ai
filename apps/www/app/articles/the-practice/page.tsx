import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Practice',
  description: 'You don\'t start with a vision. You start with an occasion. A birthday party. A backyard show. A one-night thing with thirty people who already know each other.',
  openGraph: {
    title: 'The Practice',
    description: 'Event node. Family node. Community node. Business node. That\'s the practice. That\'s the guild. That\'s what it means to run a node.',
    url: 'https://imajin.ai/articles/the-practice',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'The Practice',
    description: 'Event node. Family node. Community node. Business node. That\'s the practice. That\'s the guild.',
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
          The Practice
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          That's the practice. That's the guild. That's what it means to run a node.
        </p>

        <h2>The First Node You Run</h2>
        <p>You don't start with a vision. You start with an occasion.</p>
        <p>
          A birthday party. A backyard show. A one-night thing with thirty people who already know each 
          other and just need a room. You've been to enough events on borrowed infrastructure — 
          Eventbrite taking its cut, Facebook owning the invite list, Venmo building an advertising 
          profile from the money that changed hands — that the alternative is obvious once you see it.
        </p>
        <p>So you run an event node.</p>
        <p>
          You spin it up. You set the occasion — what it is, when it is, who it's for. You issue access 
          to the people you trust, one by one, through your trust graph. They get a credential. Not a 
          ticket on a platform that owns the relationship. A signed assertion that they belong in the 
          room. They show up. The room is real. The transactions are real. Value moves directly from 
          person to person with no platform in the way.
        </p>
        <p>Then it closes.</p>
        <p>
          The event is over. The node doesn't disappear — it becomes a memory. A permanent, signed 
          record of who was there, who vouched for whom, what happened. The memory belongs to the 
          people who made it. Not to Eventbrite. Not to Facebook. Not to anyone who wasn't in the room.
        </p>
        <p>
          And you — the person who ran it — you learned something. You learned what vouching feels 
          like. What it costs when the wrong person gets in. What the difference is between a room with 
          character and one without. You practiced the judgment that makes a good operator before 
          you're responsible for anything permanent.
        </p>
        <p>The event node is the practice space. That's what it's for.</p>
        <p>
          Run enough event nodes and something shifts. You stop thinking of yourself as someone who 
          used borrowed infrastructure and started using better infrastructure. You start thinking of 
          yourself as someone who runs rooms.
        </p>
        <p>That's the moment. That's when the operator emerges.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Family Node</h2>
        <p>After you've felt what a room with no extraction looks like, you start noticing everywhere else you want it.</p>
        <p>The answer is: everywhere. But most urgently, most intimately, most obviously — family.</p>
        <p>
          The family trust graph is the oldest one. It predates every institution. The family knows who 
          you are before any state or platform does. The family vouches for you in ways no algorithm 
          can replicate or replace.
        </p>
        <p>And right now it lives nowhere that serves it.</p>
        <p>
          The family's shared life is distributed across text threads owned by Apple, photo albums 
          owned by Google, group chats owned by Meta, money moving through Venmo which is building an 
          advertising profile from your grandmother's birthday transfer. Every platform that holds a 
          piece of your family's shared life is extracting from it. None of them are accountable to the 
          family. All of them can change the terms tomorrow.
        </p>
        <p>The family node is sovereign. It belongs to the family.</p>
        <p>
          The identity layer means your grandmother's presence on the network is hers — she doesn't 
          need a Google account to be in the family's trust graph. The payment rails mean the kid going 
          to college receives money from grandma directly, without a platform building a behavioral 
          profile from the transaction. The trust graph means the family knows who's in it — the new 
          partner gets vouched in by the person who brought them, with the standing of the person who 
          vouched on the line.
        </p>
        <p>
          The family node handles the things families actually need. Who do we trust with the kids? Who 
          has the medical power of attorney if something goes wrong? Who gets told first when something 
          happens? These aren't social network questions. They're trust graph questions. The answers 
          have always lived in human relationships. Now they can live in infrastructure that holds them too.
        </p>
        <p>
          And the memory function matters here more than anywhere else. The event node closes and 
          becomes a record of one night. The family node accumulates across years — the births, the 
          deaths, the gatherings, the slow accretion of shared history that makes a family a family. 
          All of it sovereign. All of it theirs. None of it held hostage by a platform that can delete 
          the account, sell the data, or simply cease to exist.
        </p>
        <p>
          The family node isn't a product. It's what infrastructure looks like when it finally serves 
          the people it's supposed to serve.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Community Node</h2>
        <p>The community node is where the operator role fully emerges.</p>
        <p>
          Not time-bounded. Not defined by biology. Defined by shared passion, shared practice, shared 
          commitment to a thing that matters.
        </p>
        <p>
          The demoscene. A music scene. A meditation community. A neighborhood that wants to be a 
          neighborhood again. A professional guild. A creative collective in a shipping container in 
          Cape Town. Any gathering of people who keep showing up around something they care about.
        </p>
        <p>
          The community node is what b0bby's World was — a place people went with intention, a daily 
          ritual of connection around shared passion, a room with a character that emerged from the 
          curation of the person who ran it and the culture of the people who inhabited it.
        </p>
        <p>
          Running a community node is the full practice of the operator role. You're not just managing 
          an event. You're responsible for a culture. You decide who gets vouched in. You hold the line 
          on what the room is for. You notice when something shifts — when someone's making people 
          uncomfortable, when the energy changes, when a new person is exactly the right fit — and you 
          act on what you notice.
        </p>
        <p>
          This is where the skills the CS people already have become genuinely essential. Not the 
          credential. The instinct. The ability to feel where a system wants to be. To sense load 
          before it becomes failure. To know which edge case is about to compound. Except the system 
          isn't a codebase anymore. It's a community. And the pattern recognition that made you good at 
          one makes you good at the other.
        </p>
        <p>
          The community node is also where the economics of the network become real in a human way. The 
          inference fees circulating through your trust graph aren't abstract microtransactions. 
          They're the community paying for the value the community creates. The person who holds the 
          pattern library — who knows the history, who remembers how it started, who understands the 
          culture better than anyone — gets compensated for that knowledge. Not by a platform 
          extracting from both sides. By the community itself, through the infrastructure that serves it.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Business Node</h2>
        <p>The business node is the operator running infrastructure for a client.</p>
        <p>
          A venue. A label. A brand that wants a direct relationship with its community without a 
          platform owning the rails. A professional services firm whose client relationships are its 
          actual asset and who is tired of those relationships living in Salesforce. Any organization 
          that creates genuine value and is currently paying rent to a middleman for the privilege of 
          reaching the people who want what they make.
        </p>
        <p>
          The business node is where the CS people who became operators start building practices. Not 
          employment — clients. A portfolio of nodes you run and maintain. Infra, hardening, security, 
          monitoring. The deep technical skills migrate upward into a more human role: you're not 
          building the CRUD app anymore, you're ensuring the integrity of the room. Making sure the 
          node stays sovereign. Making sure the trust graph isn't being gamed. Making sure the memory 
          persists correctly.
        </p>
        <p>
          This is a more interesting job than most of them have been doing. And it's one AI can't do 
          alone — because the attack surface is human relationships. You need someone who understands 
          both layers. The technical and the human. The system and the culture that runs on it.
        </p>
        <p>
          The staffing agency rented your credential. The guild gives you a practice. The business node 
          is where the practice generates sustainable income — not from a platform taking a cut, but 
          from clients who understand that the person running their infrastructure is the person 
          responsible for the integrity of their most valuable relationships.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Multiple Nodes</h2>
        <p>A skilled operator runs a portfolio.</p>
        <p>
          The sysop who ran Happy Boat and then b0bby's World — that's the pattern already. You learn 
          the craft on one room and it transfers. The judgment you built running event nodes becomes 
          the foundation for the community node. The community node teaches you what business clients 
          actually need. The business node funds the community node you were always doing for love.
        </p>
        <p>
          Different rooms. Different cultures. Different levels of intimacy and commitment. A business 
          node for a client during the day. A community node for a music scene in the evenings. An 
          event node for a friend's birthday on Saturday. The operator learns to hold multiple rooms 
          simultaneously — to feel the difference between them, to give each one what it needs, to not 
          let the business node's logic contaminate the community node's culture.
        </p>
        <p>
          This is also the redundancy model. The network doesn't depend on any single operator. If one 
          node goes dark — the operator burns out, moves on, decides to close it — the community can 
          migrate to another node, carrying the trust graph and the memory with them. The relationships 
          persist even when the infrastructure changes. The people are the thing. Always were.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>The Arc</h2>
        <p>Event node. Family node. Community node. Business node.</p>
        <p>Ascending intimacy. Ascending commitment. Ascending responsibility.</p>
        <p>
          You start with an occasion and learn the craft. You bring the craft home to the people who 
          matter most. You build a room for people who share your passion. You build a practice from 
          what you know how to do.
        </p>
        <p>
          Each stage produces the skills the next stage requires. Each stage is also complete in 
          itself — you don't have to run a business node to be a real operator. Running an event node 
          for your friend's show, running it well, caring about the room — that's the whole thing. The 
          full practice in miniature.
        </p>
        <p>The guild has an apprenticeship model whether anyone designed one or not. The architecture produces it.</p>
        <p>
          And when the event node closes — when the show is over, the party is done, the occasion has 
          passed — it becomes a memory. A permanent record of a room that existed, held in 
          infrastructure that belongs to the people who were in it.
        </p>
        <p>
          The operator's history is the rooms they've been responsible for. The accumulation of 
          occasions that mattered. The communities that formed and persisted. The businesses that 
          trusted them with their most valuable relationships.
        </p>
        <p>Not a resume. A trust graph with receipts.</p>
        <p>That's the practice. That's the guild.</p>
        <p>That's what it means to run a node.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party.</p>
        <p>
          An event node. Time-bounded. The occasion is the demo. First real transaction on sovereign 
          infrastructure. First real trust graph operating in public.
        </p>
        <p>
          But also: the first practice space. The first room where anyone watching can think — <em>I 
          could run one of these.</em>
        </p>
        <p>
          For a friend's show. For a family gathering. For the community that's been meeting in 
          borrowed spaces for years and deserves a room of its own.
        </p>
        <p>The event node is the door. Everything else is what you find when you walk through it.</p>
        <p>Come run a room.</p>

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
