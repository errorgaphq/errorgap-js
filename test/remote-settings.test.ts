import { describe, it, expect, afterEach } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(overrides: Record<string, unknown> = {}): Client {
  return new Client(
    new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "key-demo",
      logger: null,
      sourceMaps: false,
      remoteSettings: true,
      ...overrides,
    }),
  );
}

describe("remote settings", () => {
  it("stop errors being sent when the project switches them off", async () => {
    const calls: Array<[string, string]> = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push([init.method ?? "GET", String(url)]);
      return new Response(JSON.stringify({ errors_enabled: false, apm_enabled: true, poll_interval_seconds: 600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sdk = client();
    expect(sdk.remote.enabled("errors")).toBe(true); // on until errorgap says otherwise
    sdk.remote.stop();
    expect(await sdk.remote.refresh()).toBe(true);
    expect(calls[0]).toEqual(["GET", "https://errorgap.example.com/api/projects/demo/config"]);

    await sdk.notify(new Error("x"), { sync: true });
    expect(calls.some(([method]) => method === "POST")).toBe(false);
    expect(sdk.remote.enabled("apm")).toBe(true);
    sdk.remote.stop();
  });

  it("keep everything on when the settings cannot be read or the option is off", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const sdk = client();
    expect(await sdk.remote.refresh()).toBe(false);
    expect(sdk.remote.enabled("errors")).toBe(true);
    sdk.remote.stop();
    expect(client({ remoteSettings: false }).remote.enabled("errors")).toBe(true);
  });
});
