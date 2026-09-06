import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getForestScopeConfig } from "../src/forest-config";

const ENV_KEYS = ["PROFILE_SERVICE_URL", "NODE_ENV"] as const;
const GROUP_DID = "did:imajin:forest-group";

describe("getForestScopeConfig", () => {
  let saved: Record<string, string | undefined>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it("returns the parsed scope fee on a 200 response", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabledServices: [], landingService: null, scopeFeeBps: 40 }) });

    expect(await getForestScopeConfig(GROUP_DID)).toEqual({ scopeFeeBps: 40 });
  });

  it("calls the profile service's public forest config endpoint using PROFILE_SERVICE_URL when set", async () => {
    process.env.PROFILE_SERVICE_URL = "https://profile.example.com";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ scopeFeeBps: null }) });

    await getForestScopeConfig(GROUP_DID);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://profile.example.com/api/forest/${encodeURIComponent(GROUP_DID)}/config/public`
    );
  });

  it("falls back to the canonical dev port + /profile prefix when PROFILE_SERVICE_URL is unset", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ scopeFeeBps: null }) });

    await getForestScopeConfig(GROUP_DID);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/profile/api/forest/${encodeURIComponent(GROUP_DID)}/config/public`
    );
  });

  it("returns scopeFeeBps: null when the response omits it (unconfigured group)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabledServices: [], landingService: null }) });

    expect(await getForestScopeConfig(GROUP_DID)).toEqual({ scopeFeeBps: null });
  });

  it("returns null and warns with the URL hit on a non-2xx response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "not found" }) });

    expect(await getForestScopeConfig(GROUP_DID)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("404");

    warnSpy.mockRestore();
  });

  it("returns null and warns when the fetch throws (network error)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("connection refused"));

    expect(await getForestScopeConfig(GROUP_DID)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("connection refused");

    warnSpy.mockRestore();
  });
});
