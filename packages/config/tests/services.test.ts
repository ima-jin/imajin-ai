import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPublicUrl, buildPublicUrlAbsolute } from "../src/services";

const ENV_KEYS = [
  "NEXT_PUBLIC_SERVICE_PREFIX",
  "NEXT_PUBLIC_DOMAIN",
  "NEXT_PUBLIC_CHAT_URL",
] as const;

describe("buildPublicUrlAbsolute", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("honors an absolute NEXT_PUBLIC_{NAME}_URL override", () => {
    process.env.NEXT_PUBLIC_CHAT_URL = "https://chat.example.com";
    expect(buildPublicUrlAbsolute("chat")).toBe("https://chat.example.com");
  });

  it("returns the canonical localhost dev port when prefix is localhost", () => {
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = "http://localhost:";
    // events devPort is 3006 in the SERVICES manifest
    expect(buildPublicUrlAbsolute("events")).toBe("http://localhost:3006");
  });

  it("builds an absolute single-domain URL from prefix + domain", () => {
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = "jin.imajin.ai/";
    expect(buildPublicUrlAbsolute("chat")).toBe("https://jin.imajin.ai/chat");
    // the node root (kernel/www) has no service suffix
    expect(buildPublicUrlAbsolute("kernel")).toBe("https://jin.imajin.ai");
  });

  it("never returns a relative path (subdomain fallback when no prefix set)", () => {
    const url = buildPublicUrlAbsolute("pay");
    expect(url.startsWith("http")).toBe(true);
    expect(url).toBe("https://pay.imajin.ai");
  });
});

describe("buildPublicUrl (relative behavior is unchanged)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns a relative path in prod single-node mode", () => {
    expect(buildPublicUrl("chat")).toBe("/chat");
    expect(buildPublicUrl("kernel")).toBe("");
  });
});
