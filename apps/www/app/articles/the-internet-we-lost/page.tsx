import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Pain of Knowing',
  description: 'Why I\'m still fighting for the internet we lost. Three nodes. 300 users. Marriages. Lifelong friendships. A community that persists thirty years later.',
  openGraph: {
    title: 'The Pain of Knowing',
    description: 'Why I\'m still fighting for the internet we lost. Three nodes. 300 users. Marriages. Lifelong friendships.',
    url: 'https://imajin.ai/articles/the-internet-we-lost',
    type: 'article',
    publishedTime: '2026-02-20',
    authors: ['Ryan Veteze'],
  },
  twitter: {
    card: 'summary',
    title: 'The Pain of Knowing',
    description: 'Why I\'m still fighting for the internet we lost.',
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
          The Pain of Knowing
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          Why I'm still fighting for the internet we lost
        </p>

        <h2>b0bby's World (1990-1992)</h2>
        <p>
          For a brief moment in time, I had the perfect social media platform in the palm of my hand.
        </p>
        <p>
          Between 1990 and 1992, I ran a 3-node BBS called b0bby's World. It was a music distribution 
          hub focused on the demoscene - first featuring music by a group called MAZURkA, and later, 
          Chill Productions. Three phone lines. Three modems. Three people could be connected at once.
        </p>
        <p>Nearly 300 people found their way to those three nodes.</p>
        <p>
          Every day, people would dial in. They'd check their favorite message channels for new posts. 
          They'd download the latest .MOD, .S3M and .XM files, 0-day demo scene drops and early MPEG 
          video files. Sometimes they'd play a door game with another user who happened to be online 
          or they would join a group chat with b0b and whoever else happened to be on at that moment. 
          Then they'd log off, and someone else would dial in.
        </p>
        <p>
          It started local. But word spread through the demoscene networks. Soon people were calling 
          from places in the USA. Then international numbers started appearing in the logs. People from 
          Europe. People who'd never meet in person, finding each other through shared love of tracker 
          music and demo art.
        </p>
        <p>Some of them joined the music groups. They started creating together. Collaborating across phone lines and modems.</p>
        <p>It was slow. It was intentional. It was curated. It was <em>perfect</em>.</p>
        <p>
          I'm still good friends with many of those people today. Thirty-plus years later. The connections 
          made on b0bby's World grew into a web of friendships and acquaintances that persists.
        </p>
        <p>
          My sister, Hot Tamale, met her husband, Anarchy Tech, on the BBS. When I was at my job being 
          a gas station attendant, Hot Tamale would log in to the sysop console and chat with Anarchy Tech 
          if he happened to be online. They were fifteen. They have two adult children now. Still together.
        </p>
        <p>
          This wasn't just a bulletin board system. It was a <em>hub</em>. A place people went with intention. 
          A daily ritual of connection around shared passion. The scarcity - those three nodes - created 
          intimacy. You might wait for someone to log off. You knew the other regulars. You were part of 
          something small and real.
        </p>
        <p>And it created bonds that lasted decades.</p>
        <p>Then the web came.</p>

        <h2>I Knew It Was Worse From the Beginning</h2>
        <p>
          I remember the exact feeling. Not nostalgia - I had that in real-time. Watching the BBS networks 
          dissolve into web forums. Watching web forums get absorbed into social networks. Watching social 
          networks become algorithmic feeds optimized for engagement.
        </p>
        <p>Every step - every single one - was celebrated as innovation.</p>
        <p>Every step was wrong.</p>
        <p>
          The web promised "everyone connected to everything." What it delivered was everyone shouting 
          into an algorithmic void designed to extract value from their attention.
        </p>
        <p>Here's what we lost, and when:</p>
        <p>
          <strong>The hub became a feed.</strong> Instead of going TO a place you cared about, content 
          was pushed AT you, sorted by what kept you scrolling longest.
        </p>
        <p>
          <strong>Rituals became scrolling.</strong> Instead of checking your channels with intention, 
          you refreshed compulsively, chasing the dopamine hit of something new.
        </p>
        <p>
          <strong>Community became audience.</strong> Instead of 50 people who knew each other around 
          a shared interest, you had 50,000 followers who were strangers.
        </p>
        <p>
          <strong>Curation became algorithm.</strong> Instead of a sysop who cared about the music and 
          the people, you had an AI optimizing for advertiser revenue.
        </p>
        <p><strong>The rails became the business model.</strong></p>
        <p>And that's where it all broke, permanently.</p>

        <h2>When Plumbing Becomes Profit</h2>
        <p>Here's the fatal architectural flaw of the modern internet:</p>
        <p>
          <strong>The platforms monetized the infrastructure instead of letting value be created ON 
          the infrastructure.</strong>
        </p>
        <p>
          Think about it. When you run a BBS, the cost is the cost: phone lines, hardware, your time. 
          You do it because you care about the thing - the music, the community, the conversation. The 
          value created is in what people make and share: the songs, the art, the friendships, the culture.
        </p>
        <p>The plumbing is just plumbing.</p>
        <p>
          But when venture capital got involved, the plumbing had to become the profit center. And the 
          only way to make plumbing profitable at VC scale is to:
        </p>
        <ol>
          <li><strong>Capture users</strong> - lock-in through network effects</li>
          <li><strong>Extract attention</strong> - optimize for engagement over value</li>
          <li><strong>Harvest data</strong> - surveillance as business model</li>
          <li><strong>Insert friction</strong> - make people pay to reach their own audiences</li>
          <li><strong>Grow infinitely</strong> - scale is the only metric that matters</li>
        </ol>
        <p>This is why every platform follows the same trajectory:</p>
        <ul>
          <li>Start by being useful and free</li>
          <li>Get users hooked on network effects</li>
          <li>Introduce ads</li>
          <li>Reduce organic reach</li>
          <li>Make people pay to reach their own followers</li>
          <li>Optimize algorithm for addiction</li>
          <li>Enshittify</li>
        </ul>
        <p>It's not a bug. It's the only possible outcome when you monetize the rails.</p>

        <h2>The Extraction Model is Fatally Flawed</h2>
        <p>
          Here's what makes it fatal: <strong>the extraction model destroys the thing it's extracting from.</strong>
        </p>
        <p>
          Social platforms need authentic human connection to function. But optimizing for engagement 
          over connection destroys authenticity. People stop posting what matters and start posting what 
          performs. The algorithm learns to serve rage and anxiety because those drive clicks. The town 
          square becomes a dopamine casino.
        </p>
        <p>Think about the metrics:</p>
        <p>
          Three nodes. 300 users. Marriages. Lifelong friendships. International collaborations. A 
          community that persists thirty years later.
        </p>
        <p>Versus:</p>
        <p>
          Billions of users. Trillions of connections. Record rates of loneliness, anxiety, and depression. 
          Friendships that exist only as follower counts. People who can't remember the last time social 
          media made them feel genuinely connected to another human.
        </p>
        <p>
          The extraction model optimizes for scale and engagement, but it destroys depth and meaning. 
          And then users burn out. They quit, or they stay but disengage. The well runs dry.
        </p>
        <p>
          We're watching it happen in real-time. Every platform is struggling with the same problem: 
          users are tired of being the product. They're tired of algorithmic manipulation. They're tired 
          of watching their genuine human need for connection get optimized into an addiction they're ashamed of.
        </p>
        <p>The model is collapsing under its own contradictions.</p>

        <h2>Thirty Years of Being Right</h2>
        <p>Do you know what it's like to watch this happen, clearly, for thirty years?</p>
        <p>To see the architecture of real community get dismantled and replaced with engagement metrics?</p>
        <p>To watch every "innovation" move further from what actually worked?</p>
        <p>To explain to people what we lost and have them not understand because they never experienced it?</p>
        <p>To build the alternative over and over, only to be told "but how will it scale?" as if scale was the point?</p>
        <p>I'm not angry. I'm not bitter. I'm in <em>pain</em>.</p>
        <p>Here's what makes it devastating:</p>
        <p>
          <strong>I created more lasting human value from my parents' basement with three phone lines 
          than trillion-dollar platforms have created with billions of users.</strong>
        </p>
        <p>
          I wasn't some genius with unlimited resources. I was a teenager with modems and passion. The 
          architecture I built - almost by accident, just because it made sense - created marriages, 
          lifelong friendships, international artistic collaborations that persist decades later.
        </p>
        <p>
          And now I watch platforms with unlimited capital, the world's best engineers, decades of 
          research into human psychology, billions of dollars in VC funding... and they produce 
          loneliness, addiction, and rage.
        </p>
        <p>Not because they're incompetent.</p>
        <p>Because the extraction model makes it <em>impossible</em> to do what I did.</p>
        <p>
          When you optimize for scale and engagement, you destroy intimacy and meaning. When you monetize 
          the rails, you have to extract value from every interaction. When growth is the only metric 
          that matters, you can't create the constraints that made b0bby's World work.
        </p>
        <p>They can't build what I built because their business model won't allow it.</p>
        <p>
          That's the pain. Not nostalgia. Not bitterness. The pain of knowing that the solution has 
          always been obvious, but the architecture of modern capitalism makes it impossible to 
          implement at the scale where money can be made.
        </p>
        <p>
          So we're stuck in this loop: platforms launch with good intentions, attract users, take VC 
          money, optimize for growth, enshittify, collapse, repeat.
        </p>
        <p>
          And every cycle, I watch people discover what I've known since 1992: <strong>the extraction 
          model is fundamentally incompatible with human flourishing.</strong>
        </p>
        <p>
          This is why I get so invested. Why I manifest with all my energy. Why I can't let it go.
        </p>
        <p>
          Because I'm not theorizing. I <em>lived</em> the better way. I ran b0bby's World. I know what 
          connection without extraction feels like. I've spent thirty years watching the industry 
          optimize away the thing that mattered most.
        </p>
        <p>And now, finally, the tools exist to build it again.</p>

        <h2>What the BBS Would Have Become</h2>
        <p>I'm building a platform called imajin.ai.</p>
        <p>It's not a social network. It's not trying to compete with Twitter or Facebook or anything else.</p>
        <p>It's infrastructure. Sovereign infrastructure for identity, payments, attribution, and more.</p>
        <p>Here's how it works:</p>
        <p>
          <strong>You own your identity.</strong> Not Facebook. Not Google. You. Cryptographically. A 
          decentralized identifier (DID) that no platform can revoke or control.
        </p>
        <p>
          <strong>You own your data.</strong> It lives on your node. Not in someone's cloud. Not being 
          harvested for ad targeting.
        </p>
        <p>
          <strong>Payments are plumbing.</strong> Built in, frictionless, direct. Stripe or Solana, your 
          choice. No platform taking 30%. Money flows from person to person for value exchanged.
        </p>
        <p>
          <strong>Attribution is protocol.</strong> .fair manifests embedded in everything. Who made what. 
          Who gets paid. No platform controlling or obfuscating the value chain.
        </p>
        <p>
          <strong>Connections are intentional.</strong> One by one. Invitation chains so you know who 
          vouched for whom. No algorithmic suggestion of "people you may know."
        </p>
        <p>
          <strong>Discovery is passive.</strong> You post to your node when you have something to share. 
          People's agents check your node when they want to. No feed algorithm. No notification anxiety. 
          Just: Mark posted a picture of his cat. Sarah shared an article that three people are discussing. 
          Leah's having a party in three days.
        </p>
        <p>It's the BBS model, rebuilt for 2026.</p>
        <p>Slow. Intentional. Curated. Owned.</p>

        <h2>The Town Square Returns</h2>
        <p>
          When the plumbing is just plumbing - not monetized, not surveilled, not optimized for 
          extraction - something beautiful happens:
        </p>
        <p>
          <strong>Value gets created in town squares where people gather to trade human things.</strong>
        </p>
        <p>Art. Music. Skills. Labor. Ideas. Friendship.</p>
        <p>
          The wealth (not monetary wealth, but real human wealth) emerges from what people make and 
          share and become. Not from rent-seeking middlemen inserting themselves into every transaction.
        </p>
        <p>
          This is what b0bby's World had. Not because it was old or simple, but because its architecture 
          served connection instead of extraction.
        </p>
        <p>This is what the internet could have been.</p>
        <p>This is what it still can be.</p>
        <p>
          The inversion: platforms currently take everything by default, and you beg for privacy settings.
          Sovereign infrastructure means you own everything by default, and you selectively grant access.
          Prove you're over 18 without revealing your birthdate. Share your email with one service but not another.
          Your call, every time.
        </p>

        <h2>April 1st, 2026</h2>
        <p>I'm launching with an April Fool's Day party.</p>
        <p>
          Jin - an AI presence living in a 512-LED volumetric cube - is throwing the first event on 
          the sovereign network. Tickets are $1 virtual, $10 physical. First real transaction proving 
          the stack works end-to-end.
        </p>
        <p>People will think it's a joke.</p>
        <p>Let them.</p>
        <p>
          April 2nd, Jin will still be there. The network will still work. And nobody will be able to 
          shut it down because nobody controls it.
        </p>
        <p>The joke is that they won't get the joke.</p>
        <p>They'll think I'm trying to compete with their platforms.</p>
        <p>I'm not competing. I'm building the plumbing they should have built in 1995.</p>

        <h2>Why This Has to Work</h2>
        <p>
          Technically, it's simple. Identity + payments + federation + signed messages. This is all 
          solved engineering.
        </p>
        <p>
          The question isn't whether it <em>can</em> work. The question is whether enough people 
          remember (or never knew) what connection without extraction feels like.
        </p>
        <p>I think they do. I think the exhaustion is real. I think people are tired.</p>
        <p>And I think the tooling has finally crossed the threshold where this becomes possible.</p>
        <p>
          A few months ago, building this was still a heavy lift. Last week I spun up a working karaoke queue management
          app in two minutes. The tools finally match the vision.
        </p>
        <p>Thirty years of being right. Thirty years of pain. Thirty years of knowing.</p>
        <p>Now we build.</p>
        <p>See you in the town square.</p>
        <p className="text-gray-500">— Ryan VETEZE aka b0b</p>

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
