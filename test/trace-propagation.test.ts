import { afterEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";
import { Configuration } from "../src/configuration";
import { startPerformance, stopPerformance, type PerformanceOptions } from "../src/performance";

vi.mock("web-vitals", () => ({
  onLCP: (_: (m: Metric) => void) => {},
  onINP: (_: (m: Metric) => void) => {},
  onCLS: (_: (m: Metric) => void) => {},
  onFCP: (_: (m: Metric) => void) => {},
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Start monitoring with a fake fetch that records the headers each call carried. */
function setup(options: PerformanceOptions = {}) {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const batches: any[] = [];
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/projects/shop/browser")) {
      batches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }
    seen.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  globalThis.fetch = window.fetch;
  const monitor = startPerformance(
    new Configuration({ endpoint: "https://errorgap.example.com", projectSlug: "shop", apiKey: "k", logger: null }),
    { flushIntervalMs: 60_000, ...options },
  )!;
  const flushed = async () => {
    monitor.flush(false);
    await new Promise((r) => setTimeout(r, 0));
    return batches.flatMap((b) => b.requests);
  };
  return { seen, flushed };
}

describe("trace propagation", () => {
  afterEach(() => stopPerformance());

  it("sends x-errorgap-trace on same-origin calls and records the same id", async () => {
    const { seen, flushed } = setup();
    await fetch("/api/orders/7", { headers: { authorization: "Bearer t" } });
    const header = seen[0]!.headers.get("x-errorgap-trace");
    expect(header).toMatch(UUID);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer t");
    const [timing] = await flushed();
    expect(timing.trace_id).toBe(header);
  });

  it("keeps cross-origin calls untouched unless the origin is listed", async () => {
    const { seen, flushed } = setup({ tracePropagationTargets: ["https://api.shop.example"] });
    await fetch("https://cdn.other.example/x.json");
    await fetch("https://api.shop.example/v1/cart");
    expect(seen[0]!.headers.has("x-errorgap-trace")).toBe(false);
    expect(seen[1]!.headers.get("x-errorgap-trace")).toMatch(UUID);
    const timings = await flushed();
    expect(timings[0].trace_id).toBeUndefined();
    expect(timings[1].trace_id).toBe(seen[1]!.headers.get("x-errorgap-trace"));
  });

  it("keeps the headers of a Request passed as input", async () => {
    const { seen } = setup();
    await fetch(new Request(`${location.origin}/api/cart`, { headers: { "x-csrf": "abc" } }));
    expect(seen[0]!.headers.get("x-csrf")).toBe("abc");
    expect(seen[0]!.headers.get("x-errorgap-trace")).toMatch(UUID);
  });

  it("sets the header on same-origin XHR", async () => {
    setup();
    const set = vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader");
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/orders/7");
    try {
      xhr.send();
    } catch {
      // happy-dom may refuse the network; the header is set before send.
    }
    expect(set).toHaveBeenCalledWith("x-errorgap-trace", expect.stringMatching(UUID));
    set.mockRestore();
  });
});
