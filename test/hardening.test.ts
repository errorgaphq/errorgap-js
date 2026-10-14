import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";
import { buildNotice } from "../src/notice.js";
import { Deduper, isNoise } from "../src/noise.js";
import { filterParams } from "../src/filter.js";

const originalFetch = globalThis.fetch;
let bodies: any[];
let responses: Array<() => Response>;

beforeEach(() => {
  bodies = [];
  responses = [() => new Response('{"group_id":"g"}', { status: 201 })];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return (responses.length > 1 ? responses.shift()! : responses[0]!)();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(overrides: Record<string, unknown> = {}): Client {
  return new Client(
    new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      logger: null,
      sourceMaps: false,
      ...overrides,
    }),
  );
}

function notice(message: string, stack?: string) {
  const error = new Error(message);
  error.stack = stack ?? "";
  return buildNotice(error, new Configuration({ endpoint: "x", projectSlug: "demo" }));
}

describe("noise", () => {
  it("drops cross-origin script errors, extension errors and ResizeObserver notices", () => {
    expect(isNoise(notice("Script error."))).toBe(true);
    expect(isNoise(notice("ResizeObserver loop limit exceeded"))).toBe(true);
    expect(
      isNoise(notice("x is undefined", "Error: x\n    at run (chrome-extension://abc/content.js:1:2)")),
    ).toBe(true);
    expect(isNoise(notice("x is undefined", "Error: x\n    at run (https://app.test/main.js:1:2)"))).toBe(false);
  });

  it("is not sent, unless ignoreNoise is off", async () => {
    const script = new Error("Script error.");
    script.stack = "";
    expect((await client().notify(script, { sync: true })).dropped).toBe("noise");
    expect((await client({ ignoreNoise: false }).notify(script, { sync: true })).status).toBe(201);
    expect(bodies).toHaveLength(1);
  });
});

describe("duplicates", () => {
  it("lets an identical error through once per window", () => {
    const deduper = new Deduper();
    const boom = notice("boom");
    expect(deduper.duplicate(boom, 1000, 0)).toBe(false);
    expect(deduper.duplicate(boom, 1000, 500)).toBe(true);
    expect(deduper.duplicate(notice("other"), 1000, 600)).toBe(false);
    expect(deduper.duplicate(boom, 1000, 1001)).toBe(false);
    expect(deduper.duplicate(boom, 0, 1002)).toBe(false);
  });

  it("sends a looping error once", async () => {
    const sdk = client();
    const results = [];
    for (let n = 0; n < 5; n++) results.push(await sdk.notify(new Error("loop"), { sync: true }));
    expect(bodies).toHaveLength(1);
    expect(results.filter((result) => result.dropped === "duplicate")).toHaveLength(4);
  });
});

describe("notices", () => {
  it("carry the user, the cause chain and masked nested keys", async () => {
    const sdk = client();
    sdk.setUser({ id: 7, email: "ada@example.com" });
    await sdk.notify(Object.assign(new Error("outer"), { cause: new TypeError("inner") }), {
      sync: true,
      params: { form: [{ password: "x" }] },
    });
    expect(bodies[0].session).toEqual({ user_id: "7", user_email: "ada@example.com" });
    expect(bodies[0].context.causes).toEqual([{ type: "TypeError", message: "inner" }]);
    expect(bodies[0].params.form[0].password).toBe("[FILTERED]");
  });

  it("survive params that JSON cannot carry", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => JSON.stringify(filterParams({ loop, big: 1n }, []))).not.toThrow();
  });

  it("can be dropped or changed by beforeNotify", async () => {
    expect((await client({ beforeNotify: () => false }).notify(new Error("a"), { sync: true })).dropped).toBe(
      "beforeNotify",
    );
    await client({
      beforeNotify: (payload: any) => {
        payload.context.plan = "pro";
      },
    }).notify(new Error("b"), { sync: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].context.plan).toBe("pro");
  });
});

describe("delivery", () => {
  it("stops sending after a 429 until Retry-After has passed", async () => {
    responses = [() => new Response("{}", { status: 429, headers: { "retry-after": "120" } })];
    const sdk = client({ dedupeWindowMs: 0 });
    expect((await sdk.notify(new Error("one"), { sync: true })).status).toBe(429);
    expect((await sdk.notify(new Error("two"), { sync: true })).error).toBeDefined();
    expect(bodies).toHaveLength(1);
  });

  it("holds notices while offline and sends them when back online", async () => {
    const sdk = client({ dedupeWindowMs: 0 });
    await sdk.notify(new Error("warm up"), { sync: true });
    window.dispatchEvent(new Event("offline"));
    void sdk.notify(new Error("queued while offline"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    await sdk.flush();
    expect(bodies.map((body) => body.errors[0].message)).toEqual(["warm up", "queued while offline"]);
  });
});
