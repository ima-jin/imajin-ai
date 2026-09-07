import { describe, it, expect, vi } from "vitest";
import { getNodeSelf } from "../src/node-self";
import { useStubbedServiceEnv } from "./service-url-test-utils";

const ENV_KEYS = ["REGISTRY_SERVICE_URL", "REGISTRY_URL", "NODE_ENV", "PORT"] as const;

describe("getNodeSelf", () => {
  const env = useStubbedServiceEnv(ENV_KEYS);

  it("returns the parsed node self info on a 200 response", async () => {
    const info = {
      did: "did:imajin:jin",
      nodeOperatorDid: "did:imajin:operator",
      nodeFeeBps: 50,
      buyerCreditBps: 25,
    };
    env.fetchMock.mockResolvedValue({ ok: true, json: async () => info });

    expect(await getNodeSelf()).toEqual(info);
  });

  it("calls the registry's node/self endpoint using the prefixed REGISTRY_SERVICE_URL when set (#2046)", async () => {
    // Like every other *_SERVICE_URL, the env var includes the service's
    // path prefix (`/registry`) — the fetch must append only `/api/node/self`.
    process.env.REGISTRY_SERVICE_URL = "https://registry.example.com/registry";
    env.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ did: "did:imajin:jin", nodeOperatorDid: null, nodeFeeBps: null, buyerCreditBps: null }),
    });

    await getNodeSelf();
    expect(env.fetchMock).toHaveBeenCalledWith("https://registry.example.com/registry/api/node/self");
  });

  it("does not double-prefix when REGISTRY_SERVICE_URL already includes /registry (#2046 regression)", async () => {
    process.env.REGISTRY_SERVICE_URL = "http://localhost:7000/registry";
    env.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ did: "did:imajin:jin", nodeOperatorDid: null, nodeFeeBps: null, buyerCreditBps: null }),
    });

    await getNodeSelf();
    const calledUrl = env.fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("http://localhost:7000/registry/api/node/self");
    expect(calledUrl).not.toContain("/registry/registry");
  });

  it("falls back to the canonical dev port + /registry prefix when REGISTRY_SERVICE_URL is unset", async () => {
    env.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ did: "did:imajin:jin", nodeOperatorDid: null, nodeFeeBps: null, buyerCreditBps: null }),
    });

    await getNodeSelf();
    expect(env.fetchMock).toHaveBeenCalledWith("http://localhost:3000/registry/api/node/self");
  });

  it("returns null and warns with the URL hit on a non-2xx response (e.g. 503 not configured)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    env.fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Node identity not configured" }) });

    expect(await getNodeSelf()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("http://localhost:3000/registry/api/node/self");
    expect(warnSpy.mock.calls[0][0]).toContain("503");

    warnSpy.mockRestore();
  });

  it("returns null and warns when the fetch throws (network error)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    env.fetchMock.mockRejectedValue(new Error("connection refused"));

    expect(await getNodeSelf()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("connection refused");

    warnSpy.mockRestore();
  });
});
