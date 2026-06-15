import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFakeFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | Headers | undefined;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = value;
      }
    }
    let body: unknown = init?.body;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body,
    });
    return new Response('{"group_id":"g_1"}', {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return captured;
}

describe("Client.notify", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /api/projects/:slug/notices with canonical headers", async () => {
    const config = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("test"), { sync: true });
    expect(result.status).toBe(201);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://errorgap.example.com/api/projects/demo/notices");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-errorgap-project-key"]).toBe("flk_test");
  });

  it("sends the notice envelope", async () => {
    const config = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(config);
    await client.notify(new TypeError("boom"), { sync: true });

    const body = requests[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("context");
    const firstError = (body.errors as Array<{ type: string; message: string }>)[0]!;
    expect(firstError.type).toBe("TypeError");
    expect(firstError.message).toBe("boom");
  });

  it("returns an error result when endpoint is missing", async () => {
    const config = new Configuration({ projectSlug: "demo", logger: null });
    const client = new Client(config);
    const result = await client.notify(new Error("x"), { sync: true });
    expect(result.error).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("returns queued=true and 202 when async", async () => {
    const config = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: true,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("x"));
    expect(result.queued).toBe(true);
    expect(result.status).toBe(202);
    await client.flush();
    expect(requests).toHaveLength(1);
  });

  it("returns sampled=true and does not send when sampleRate=0", async () => {
    const config = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      sampleRate: 0,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("x"), { sync: true });
    expect(result.sampled).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
