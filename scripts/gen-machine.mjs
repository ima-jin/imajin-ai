#!/usr/bin/env node
// gen-machine.mjs — derive terse .machine/<n>.md specs from verbose GitHub artifacts
// using the local RTX 5090 (Ollama). Idempotent via derived-from sha256 drift check.
//
// Usage:
//   node scripts/gen-machine.mjs issue 1327            # one issue
//   node scripts/gen-machine.mjs issue --all           # all open issues
//   node scripts/gen-machine.mjs pr 1329               # one PR (description)
//   node scripts/gen-machine.mjs --dry 1327            # print, don't write
//
// Env: OLLAMA_URL (default http://192.168.1.234:11434), MODEL (default qwen3:14b),
//      REPO (default ima-jin/imajin-ai)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Plaintext http is deliberate: Ollama serves its API without TLS, and this
// default addresses a private-LAN host rather than the internet. Point
// OLLAMA_URL at an https reverse proxy if you expose the box beyond the LAN.
const OLLAMA = process.env.OLLAMA_URL ?? "http://192.168.1.234:11434"; // NOSONAR — private-LAN Ollama endpoint, no TLS listener to talk to
const MODEL = process.env.MODEL ?? "qwen3:14b";
const REPO = process.env.REPO ?? "ima-jin/imajin-ai";
const DRY = process.argv.includes("--dry");

const SYSTEM = `You compress verbose GitHub issue/PR text into a TERSE machine spec for AI dev orchestrators (coder agents, CI) to ingest cheaply. Output ONLY the spec, no preamble.

RULES:
- Keep: the concrete plan/loop, invariants/constraints, milestones, refs (#numbers), reused components.
- Drop: rationale, justification, backstory, thesis/philosophy, "why this matters", motivational framing.
- Rules are for machines; the "why" stays in the source. Never invent facts not in the source.
- Format as short markdown: a 1-3 line summary, then bulleted sections (Invariants / Milestones / Reuses / Refs) only if the source has them.
- Target ~5x shorter than the source. Be dense, not chatty.

CRITICAL OUTPUT CONTRACT:
- Do NOT think out loud, explain, self-correct, or add any commentary.
- Emit the spec ONCE, wrapped EXACTLY between a line "<<<SPEC>>>" and a line "<<<END>>>". Nothing before or after.`;

function gh(args) {
  // Resolved via PATH by design: this is a developer-workstation script, `gh` is
  // an explicit prerequisite, and an absolute path would break across the
  // macOS/Linux/Windows installs the team uses. execFileSync spawns without a
  // shell, so the argv list is never shell-interpreted.
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }); // NOSONAR — dev-only script, no elevated privileges
}

// Both issues and PRs expose the same three fields to `gh ... view --json`.
const ARTIFACT_FIELDS = "body,title,url";

function fetchArtifact(kind, num) {
  const json = JSON.parse(gh([kind, "view", String(num), "--repo", REPO, "--json", ARTIFACT_FIELDS]));
  return { title: json.title, body: json.body ?? "", url: json.url };
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function existingHash(path) {
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(/derived-from:\s*sha256:([0-9a-f]{64})/);
  return m ? m[1] : null;
}

async function compress(title, body) {
  const prompt = `TITLE: ${title}\n\nBODY:\n${body}`;
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      system: SYSTEM,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let out = data.response;
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Last match wins: a model that ignores the "emit once" contract and restates
  // the spec should have its final answer taken, not its first draft.
  const lastMatch = [...out.matchAll(/<<<SPEC>>>([\s\S]*?)<<<END>>>/g)].at(-1);
  if (lastMatch) return lastMatch[1].trim();
  return out.trim();
}

async function genOne(kind, num) {
  const { title, body, url } = fetchArtifact(kind, num);
  if (!body.trim()) {
    console.log(`#${num}: empty body, skip`);
    return;
  }
  const hash = sha256(body);
  const path = `.machine/${kind === "pr" ? "pr-" : ""}${num}.md`;
  if (existingHash(path) === hash) {
    console.log(`#${num}: unchanged (hash match), skip`);
    return;
  }
  const spec = await compress(title, body);
  const out = `${spec}\n\nsource: ${url}\nderived-from: sha256:${hash}\n`;
  if (DRY) {
    console.log(`\n===== ${path} (${body.length} -> ${out.length} chars) =====\n${out}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
  console.log(`#${num}: wrote ${path} (${body.length} -> ${out.length} chars, ${(body.length / out.length).toFixed(1)}x)`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const kind = args[0] === "pr" ? "pr" : "issue";
  const target = args[1] ?? args[0];

  if (process.argv.includes("--all")) {
    const list = JSON.parse(gh([kind, "list", "--repo", REPO, "--state", "open", "--limit", "500", "--json", "number"]));
    console.log(`generating for ${list.length} open ${kind}s...`);
    for (const { number } of list) {
      try { await genOne(kind, number); } catch (e) { console.error(`#${number}: ERROR ${e.message}`); }
    }
    return;
  }
  await genOne(kind, target);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
