import type { ReactNode } from 'react';
import type { ReachCard } from '@/src/lib/auth/reach-discovery';
import { CopyBlock } from './copy-block';

const panel = 'min-w-0 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-[#111111] sm:p-7';
const link = 'break-all text-orange-700 underline decoration-orange-300 underline-offset-4 hover:decoration-orange-600 dark:text-orange-400';

function SetupSection({ id, title, children }: Readonly<{ id: string; title: string; children: ReactNode }>) {
  return (
    <section id={id} className={`${panel} scroll-mt-24 space-y-4`} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-xl font-semibold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

/** Renders only the resolver's intentionally public projection, never identity metadata. */
export function ReachPage({ card }: Readonly<{ card: ReachCard }>) {
  const mcp = card.transports.find(transport => transport.id === 'mcp');
  const openapi = card.transports.find(transport => transport.id === 'openapi');
  const signed = card.transports.find(transport => transport.id === 'signed');
  const displayName = card.name || (card.handle ? `@${card.handle}` : 'this person');
  const knock = `curl --request POST '${card.onboarding.endpoint}' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "agentLabel": "My assistant",
    "onBehalfOf": {
      "platform": "YOUR_PLATFORM",
      "externalRef": "YOUR_CALLER_REFERENCE"
    }
  }'`;
  const bearerInstructions = 'Obtain your own bearer with the knock example above. Use the returned bearer only in your client’s private credential settings as Authorization: Bearer <YOUR_REACH_BEARER>. Never paste it into a chat, share link, or this page.';
  const openapiInstructions = (platform: string) => `Connect ${platform} to ${displayName} using this OpenAPI document:
${openapi?.endpoint}

${bearerInstructions}

Read the document’s operations. Ask about a topic, or send a message about a published topic. Save the returned reachId and use the documented status operation to check for a reply. The recipient’s gate still decides whether a request is admitted.`;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 text-gray-900 dark:text-gray-100 sm:px-6 sm:py-16">
      <header className="mb-10 grid min-w-0 gap-8 lg:grid-cols-[1.35fr_1fr]">
        <div className="min-w-0">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-orange-700 dark:text-orange-400">A public door for your assistant</p>
          <h1 className="break-words text-4xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-5xl">Reach {displayName}</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-gray-600 dark:text-gray-400">
            Bring your own assistant. Start a conversation through a door that respects this person’s boundaries.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <a href="#setup" className="rounded-full bg-orange-600 px-5 py-3 font-medium text-white hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500">Choose your client</a>
            <a href={card.url} className="rounded-full border border-gray-300 px-5 py-3 font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">Unified JSON card</a>
          </div>
        </div>
        <aside className={`${panel} space-y-4`} aria-label="Public identity and share link">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Share this door</p>
          <CopyBlock label="Public share link" text={card.instructionsUrl} />
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Principal DID</p>
            <p className="break-all font-mono text-xs leading-relaxed">{card.principalDid}</p>
          </div>
        </aside>
      </header>

      <section className="mb-8 rounded-2xl border border-orange-200 bg-orange-50 p-5 dark:border-orange-900/60 dark:bg-orange-950/20 sm:p-7" aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="text-xl font-semibold">Your assistant. Your credential. Their boundaries.</h2>
        <div className="mt-4 grid gap-5 text-sm leading-relaxed text-gray-700 dark:text-gray-300 md:grid-cols-3">
          <p><strong className="block text-gray-900 dark:text-white">01 · Discover anonymously</strong>Read the public card and available tools without a credential. Anonymous access is discovery only, not permission to ask or send.</p>
          <p><strong className="block text-gray-900 dark:text-white">02 · Knock as yourself</strong>No owner token or owner approval is needed. Your caller obtains its own recipient-bound bearer. The on-behalf-of claim is UNVERIFIED, not proof of identity.</p>
          <p><strong className="block text-gray-900 dark:text-white">03 · Respect the gate</strong>A credential is not consent to every topic. The recipient’s gate still decides. Private rules are never published; topic checks return only a boolean.</p>
        </div>
      </section>

      <section className={`${panel} mb-10`} aria-labelledby="published-topics">
        <h2 id="published-topics" className="text-lg font-semibold">Published topics</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Only labels this person has opted to publish appear here. This is not a list of private interests or gate rules.</p>
        {card.reach.topics?.length ? (
          <ul className="mt-4 flex flex-wrap gap-2">
            {card.reach.topics.map(topic => <li key={topic} className="max-w-full break-words rounded-full border border-gray-200 px-3 py-1.5 text-sm [overflow-wrap:anywhere] dark:border-gray-700">{topic}</li>)}
          </ul>
        ) : <p className="mt-4 text-sm text-gray-500">No topic labels have been published.</p>}
      </section>

      <div id="setup" className="mb-6 scroll-mt-24">
        <h2 className="text-2xl font-semibold tracking-tight">Connect from your client</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-gray-600 dark:text-gray-400">Tool and connector access may vary by product, plan, workspace policy, and client version. A pasted prompt alone does not give an assistant network tools. OAuth sign-in and A2A are not live Reach transports.</p>
        <nav aria-label="Client setup" className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-sm">
          {mcp && <><a className={link} href="#muse">Muse / static headers</a><a className={link} href="#claude">Claude MCP</a></>}
          {openapi && <><a className={link} href="#chatgpt">ChatGPT</a><a className={link} href="#gemini">Gemini / other tools</a></>}
          {signed && <a className={link} href="#signed">Signed agents</a>}
        </nav>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <section className={`${panel} space-y-4 lg:col-span-2`} aria-labelledby="knock-title">
          <h3 id="knock-title" className="text-xl font-semibold">First, obtain your own Reach bearer</h3>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">Run this in your own trusted terminal or tool runner, replacing the caller placeholders. Knock requires a gate that admits soft-tier static-header clients; an open door does not guarantee bearer issuance. Keep the response private; this page never collects, stores, or displays your token.</p>
          <CopyBlock label="Knock request (caller placeholders)" text={knock} />
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{bearerInstructions} Signed agents can use their own keys instead.</p>
          <a className={`${link} inline-block text-sm`} href={card.onboarding.flowDocument}>Read the knock flow document</a>
        </section>
        {mcp && <>
          <SetupSection id="muse" title="Muse / static-header MCP">
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">If your client supports remote MCP with custom headers, add this recipient’s server. Knock first, then configure the Authorization header privately. This is not the owner’s MCP server or an owner access token.</p>
            <CopyBlock label="Muse MCP setup" text={`Transport: remote HTTP MCP\nServer URL: ${mcp.endpoint}\nHeader: Authorization: Bearer <YOUR_REACH_BEARER>\n\nRead reach_card, use reach_ask to check a topic, then reach_send to send your message. Save reachId and poll reach_status for the reply.`} />
            {mcp.discovery && <a href={mcp.discovery} className={`${link} inline-block text-sm`}>MCP protected resource metadata</a>}
          </SetupSection>
          <SetupSection id="claude" title="Claude / MCP-capable clients">
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">Use a Claude environment or MCP bridge that supports remote HTTP MCP and static Authorization headers. Some connector interfaces require OAuth and cannot use this flow; use a compatible tool runner instead.</p>
            <CopyBlock label="Claude MCP instructions" text={`Connect a remote HTTP MCP server at:\n${mcp.endpoint}\n\n${bearerInstructions}\n\nUse reach_card for discovery, reach_ask for a boolean topic check, reach_send to send, and reach_status with the returned reachId to poll for a reply. Do not request the recipient’s token or private rules.`} />
          </SetupSection>
        </>}
        {openapi && <>
          <SetupSection id="chatgpt" title="ChatGPT / OpenAPI">
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">In an environment with custom Actions or another OpenAPI-capable tool runner, import the document below. Configure bearer authentication privately; availability depends on your plan and workspace. An ordinary chat cannot import or execute this by itself.</p>
            <CopyBlock label="ChatGPT OpenAPI instructions" text={openapiInstructions('your OpenAPI-capable ChatGPT tool environment')} />
          </SetupSection>
          <SetupSection id="gemini" title="Gemini / tool-capable clients">
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">Use a tool-capable Gemini integration or other client that can load OpenAPI operations and set private HTTP headers. This does not claim that every consumer chat interface supports connectors.</p>
            <CopyBlock label="Gemini OpenAPI instructions" text={openapiInstructions('your Gemini integration or tool runner')} />
          </SetupSection>
        </>}
        {signed && <SetupSection id="signed" title="Agents with signing keys">
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">The signed path supports did:imajin and verified did:web requesters. Sign the canonical Reach transcript with your own Ed25519 key; do not send an unsigned placeholder payload. Authentication does not override topic policy.</p>
          <CopyBlock label="Signed agent instructions" text={`Recipient DID: ${card.principalDid}\nSigned Reach endpoint: ${signed.endpoint}\nProtocol: ${signed.protocol}\nPublic card: ${card.url}\nRequest and signing specification: ${openapi?.endpoint ?? card.url}\n\nRead the specification for canonical transcript serialization and signed status polling. Build the documented request, including requesterDid, onBehalfOf, purpose, field, predicate, arg and issuedAt. Sign the canonical Reach transcript bound to the recipient DID using your own Ed25519 key. For delivery, include topic, message and replyHandle together. Keep signing keys private.`} />
        </SetupSection>}
        <aside className={`${panel} space-y-3`} aria-labelledby="privacy-title">
          <h3 id="privacy-title" className="text-xl font-semibold">A door, not a data export</h3>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">Reach gives a caller a narrow way to ask or send. It does not unlock the recipient’s account, private data, or gate configuration. Never share a bearer publicly or include one in a message.</p>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">Use the <a className={link} href={card.url}>unified JSON card</a> as the source of current endpoints and supported authentication.</p>
        </aside>
      </div>
      <footer className="mt-10 border-t border-gray-200 pt-5 text-xs text-gray-500 dark:border-gray-800">
        Reach discovery {card.schemaVersion} · {card.reach.protocol}
      </footer>
    </main>
  );
}
