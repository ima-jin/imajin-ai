import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Network That Never Died',
  description: 'I have been building toward April 1st, 2026 for thirty-five years. The thread runs straight through. And the people on the thread are still there.',
  openGraph: {
    title: 'The Network That Never Died',
    description: 'Five nodes. Five origin stories. One thread running through all of them. The network didn\'t die. It went dormant.',
    url: 'https://imajin.ai/articles/the-network',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'The Network That Never Died',
    description: 'Five nodes. Five origin stories. One thread running through all of them. The network didn\'t die. It went dormant.',
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
          The Network That Never Died
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          The infrastructure is ready. Come find your node.
        </p>

        <p>I have been building toward April 1st, 2026 for thirty-five years.</p>
        <p>
          I didn't know that until recently. It looked like a BBS. Then it looked like a career. Then 
          it looked like a severance package and a continent to drive across. Now it looks like four 
          live services and a party where Jin's lights will sparkle when people talk to each other.
        </p>
        <p>But the thread runs straight through. And the people on the thread are still there.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Happy Boat</h2>
        <p>The first BBS I ever dialed into and stayed on was called Happy Boat.</p>
        <p>
          I don't remember exactly how I found it — probably through a list of local numbers, the way 
          you found BBSs then. Someone had written them down or uploaded a list to another board you 
          were already on. You dialed. You waited. You got a carrier signal or you didn't.
        </p>
        <p>
          Happy Boat had a carrier signal. And it was <em>weird</em>. That was the hook. Locked in from 
          the first session.
        </p>
        <p>
          Three sysops: Seth, Archemedies, and Jambalaya. Based in Markham. That same night — the same 
          night I first dialed in — I drove out there to meet them. Jet black 1983 Ford F150 Flare Side 
          pickup with a red pinstripe. The truck was trash. It looked amazing. I drove it out to 
          Markham to meet strangers from a BBS because that's how it worked. You felt it and you moved 
          toward it.
        </p>
        <p>
          Happy Boat is where I learned what a BBS could be. What it felt like to be in the right room 
          with the right people around a shared thing.
        </p>
        <p>Then I went home and built one.</p>
        <p>Seth and the Happy Boat crew are still in the network. Thirty-five years later. The thread runs straight through.</p>

        <hr className="my-12 border-gray-800" />

        <h2>b0bbys World</h2>
        <p>
          1991. I was fifteen turning sixteen. A 386 with a 40mb hard drive. Three phone lines, three 
          modems, three nodes. A music distribution hub for the demoscene — first featuring music by 
          MAZURkA, later Chill Productions.
        </p>
        <p>
          Nearly 300 users found their way to those three nodes. Local at first. Then across the 
          country. Then international — people from Europe dialing in, people who'd never meet in 
          person finding each other through shared love of tracker music and demo art.
        </p>
        <p>
          The scarcity created the intimacy. You might wait for someone to log off. You knew the 
          regulars. You were part of something small and real.
        </p>
        <p>
          My sister — Hot Tamale — met her husband Anarchy Tech on the BBS. They were both fifteen. 
          They have two adult children now. Still together.
        </p>
        <p>
          b0bbys World ran until early 1994. Then people switched to dial-up internet. IRC arrived. No 
          reason to dial a BBS when you can be on the actual internet. Reasonable. I got on it too.
        </p>
        <p>
          But the people stayed real. The connections persisted. That's what you find out, thirty years 
          later — the architecture of real community doesn't dissolve just because the platform does. 
          The platform was never the thing. The people were the thing.
        </p>

        <hr className="my-12 border-gray-800" />

        <h2>Joel</h2>
        <p>Joel was on Happy Boat.</p>
        <p>
          I won't tell his whole story — that's his to tell. But Joel is one of the people who 
          understood immediately what we were doing, without needing it explained. The people who show 
          up in your life like that — who get it before you've finished the sentence — you hold onto them.
        </p>
        <p>Thirty-five years later Joel is going to run a node on April 1st.</p>
        <p>
          Not because I convinced him. Because the essays landed the way they land on people who 
          already knew. He read them and saw himself in them. That's not recruitment. That's recognition.
        </p>
        <p>
          The trust graph between Joel and me is older than the software. It was formed in a time when 
          connection required intention — you had to dial in, you had to wait, you had to care enough 
          about the thing to show up repeatedly. The scarcity created the depth. The depth created the trust.
        </p>
        <p>That trust is the foundation of his node.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Mayhem</h2>
        <p>Mayhem was on b0bbys World.</p>
        <p>
          One of the people who became real through the connection — not just a handle but a person, 
          with a way of thinking and a sense of humour and opinions about tracker music and an 
          understanding of what we were building together even though none of us had words for it.
        </p>
        <p>
          When I started writing these essays Mayhem was one of the first people who responded. Not 
          with enthusiasm exactly — with recognition. The specific recognition of someone who was 
          there, who knew what it actually was, who has spent thirty years watching the same 
          dissolution I watched and drawing the same conclusions.
        </p>
        <p>Mayhem is going to run a node on April 1st.</p>
        <p>
          The thread from b0bbys World to the sovereign network is unbroken. The community that formed 
          on a 386 with a 40mb hard drive in 1991 is a load-bearing element of infrastructure being 
          built in 2026.
        </p>
        <p>
          That's not nostalgia. That's proof of concept. Those connections lasted because they were 
          built on something real. The architecture of real community — slow, intentional, curated, 
          around genuine shared passion — produces bonds that persist across decades.
        </p>
        <p>We have receipts.</p>

        <hr className="my-12 border-gray-800" />

        <h2>James</h2>
        <p>
          Dr. James Maskalyk is an emergency room physician who spent years doing MSF work in Sudan and 
          Ethiopia. He wrote a book about it. He had stage 4 cancer and survived. He became the 
          wellness director for fifteen hospitals. He also DJs.
        </p>
        <p>
          I'm not sure there's a cleaner example of someone who has spent his entire career at the 
          place where systems fail humans most visibly. The ER is where the extraction model sends its 
          casualties — the people who fell through every gap, in healthcare, in housing, in mental 
          health, in every system that was supposed to catch them.
        </p>
        <p>
          He understands at a bone level what it costs when infrastructure doesn't serve the people 
          it's supposed to serve.
        </p>
        <p>
          James co-founded the Consciousness Explorers Club with Jeff Warren — a community that has 
          been doing the thing we're trying to encode in software for years. People in a room together. 
          Low tech. High trust. No algorithm. No extraction. The kind of room that b0bbys World was, in 
          a different decade, with different technology, for different reasons, arriving at the same thing.
        </p>
        <p>He's going to run a node on April 1st.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Jeff</h2>
        <p>
          Jeff Warren broke his neck falling out of a tree. He has ADHD. He was a CBC journalist. He 
          co-founded the Consciousness Explorers Club with James. He built a meditation practice 
          specifically for fidgety skeptics — people who can't sit still, who find stillness 
          suspicious, who need a different entry point than "just breathe."
        </p>
        <p>
          Jeff teaches people to be present without extraction. Through apps he doesn't own, on 
          platforms he doesn't control. His work reaches people who would never find it through the 
          algorithms that are supposed to surface what matters.
        </p>
        <p>
          The thing Jeff has built — the practice, the community, the trust accumulated with people who 
          have followed him for years — lives on borrowed infrastructure. He's a sharecropper like 
          everyone else. Doing extraordinary work on land he doesn't own.
        </p>
        <p>
          A node changes that. The people who have followed Jeff for years are in his trust graph. They 
          could query him directly. He could reach them without a platform deciding who sees what.
        </p>
        <p>The work doesn't change. The infrastructure does.</p>
        <p>Jeff is going to run a node on April 1st.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Five Nodes</h2>
        <p>
          Five nodes on April 1st. Five people with history. Five communities in the same physical 
          space for one night while Jin's lights sparkle overhead.
        </p>
        <p>
          This isn't a launch event. It isn't a product showcase. It isn't a demonstration of features.
        </p>
        <p>
          It's a room. With people who trust each other. Talking. And infrastructure underneath that 
          records none of it for advertisers, routes none of it through an algorithm, extracts nothing 
          from the connection.
        </p>
        <p>
          The complexity is invisible. The auth layer, the DIDs, the E2EE, the trust graph, the payment 
          rails — none of that is visible on April 1st. What's visible is: I'm talking to people I 
          trust and nobody owns this room.
        </p>
        <p>That's the whole demo.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Thread</h2>
        <p>
          Happy Boat → b0bbys World → thirty years of corporate extraction → South Africa → AfrikaBurn 
          → two continents → home → April 1st 2026.
        </p>
        <p>
          Joel from Happy Boat. Mayhem from b0bbys World. James from the emergency room and the rave 
          and the meditation hall. Jeff from the tree he fell from and the practice he built for people 
          who can't sit still. Me from my parents' basement and a jet black F150 and the night I drove 
          to Markham to meet strangers from a BBS.
        </p>
        <p>Five nodes. Five origin stories. One thread running through all of them.</p>
        <p>
          The network didn't die. It went dormant. It was waiting for the infrastructure to catch up to 
          what it already knew how to be.
        </p>
        <p>The infrastructure is ready.</p>
        <p>April 1st. Jin's lights will sparkle. Come find your node.</p>

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
