import { describe, it, expect, vi } from "vitest";
import {
  registryServiceUrl,
  hasRegistryServiceUrl,
  __resetRegistryServiceUrlWarningForTests,
} from "../src/registry-service-url";
import { useStubbedServiceEnv } from "./service-url-test-utils";

const ENV_KEYS = ["REGISTRY_SERVICE_URL", "REGISTRY_URL", "PORT"] as const;

describe("registryServiceUrl", () => {
  useStubbedServiceEnv(ENV_KEYS);

  it("returns REGISTRY_SERVICE_URL when set, ignoring the legacy var entirely", () => {
    process.env.REGISTRY_SERVICE_URL = "https://registry.example.com/registry";
    process.env.REGISTRY_URL = "https://legacy.example.com/registry";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(registryServiceUrl()).toBe("https://registry.example.com/registry");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("falls back to the deprecated REGISTRY_URL when REGISTRY_SERVICE_URL is unset, warning once", () => {
    __resetRegistryServiceUrlWarningForTests();
    process.env.REGISTRY_URL = "http://localhost:7000/registry";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(registryServiceUrl()).toBe("http://localhost:7000/registry");
    expect(registryServiceUrl()).toBe("http://localhost:7000/registry");
    expect(registryServiceUrl()).toBe("http://localhost:7000/registry");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("REGISTRY_URL is deprecated — set REGISTRY_SERVICE_URL");

    warnSpy.mockRestore();
  });

  it("falls back to http://localhost:{PORT}/registry when neither env var is set", () => {
    __resetRegistryServiceUrlWarningForTests();
    process.env.PORT = "7000";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(registryServiceUrl()).toBe("http://localhost:7000/registry");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("falls back to http://localhost:3000/registry when neither env var nor PORT is set", () => {
    __resetRegistryServiceUrlWarningForTests();

    expect(registryServiceUrl()).toBe("http://localhost:3000/registry");
  });
});

describe("hasRegistryServiceUrl", () => {
  useStubbedServiceEnv(ENV_KEYS);

  it("is false when neither env var is set", () => {
    expect(hasRegistryServiceUrl()).toBe(false);
  });

  it("is true when REGISTRY_SERVICE_URL is set", () => {
    process.env.REGISTRY_SERVICE_URL = "https://registry.example.com/registry";
    expect(hasRegistryServiceUrl()).toBe(true);
  });

  it("is true when only the deprecated REGISTRY_URL is set", () => {
    process.env.REGISTRY_URL = "http://localhost:7000/registry";
    expect(hasRegistryServiceUrl()).toBe(true);
  });
});
