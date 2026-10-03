import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";
import { Configuration } from "../src/configuration";
import { startPerformance, stopPerformance, type PerformanceMonitor } from "../src/performance";

const vitals: Record<string, (m: Metric) => void> = {};
vi.mock("web-vitals", () => ({
  onLCP: (cb: (m: Metric) => void) => (vitals.LCP = cb),
  onINP: (cb: (m: Metric) => void) => (vitals.INP = cb),
  onCLS: (cb: (m: Metric) => void) => (vitals.CLS = cb),
  onFCP: (cb: (m: Metric) => void) => (vitals.FCP = cb),
}));

const metric = (name: string, value: number, navigationType = "navigate") =>
  ({ name, value, navigationType }) as unknown as Metric;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = () =>
  new Configuration({
    endpoint: "https://errorgap.example.com",
    projectSlug: "shop",
    apiKey: "flk_test",
    environment: "production",
    release: "abc123",
    logger: null,
  });

type Sent = { url: string; body: any; headers?: Record<string, string>; beacon: boolean };

describe("performance", () => {
  let sent: Sent[];
  let appFetch: typeof fetch;
  let monitor: PerformanceMonitor | null;

  beforeEach(() => {
    sent = [];
    window.history.replaceState(null, "", "/");
    // The page's own fetch; the SDK's batches also go through the fetch it
    // captured at start, so both are recorded here.
    appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/projects/shop/browser")) {
        sent.push({ url, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string>, beacon: false });
        return new Response(null, { status: 202 });
      }
      if (url.includes("/boom")) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: url.includes("/missing") ? 404 : 200 });
    }) as typeof fetch;
    window.fetch = appFetch;
    globalThis.fetch = window.fetch;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn((url: string, data: Blob) => {
        void data.text().then((text) => sent.push({ url, body: JSON.parse(text), beacon: true }));
        return true;
      }),
    });
    monitor = startPerformance(config(), { routeName: () => "/orders/:id", flushIntervalMs: 60_000 });
  });

  afterEach(() => {
    stopPerformance();
  });

  it("times the page's fetches without query strings, and never its own batches", async () => {
    await fetch("/api/orders/7?token=secret");
    await fetch("https://other.example.com/missing", { method: "post" });
    await expect(fetch("/boom")).rejects.toThrow();

    monitor!.flush(false);
    await wait(0);
    expect(sent).toHaveLength(1);
    const { body, headers } = sent[0]!;
    expect(headers?.["x-errorgap-project-key"]).toBe("flk_test");
    expect(body.environment).toBe("production");
    expect(body.release).toBe("abc123");
    expect(body.requests.map((r: any) => [r.method, r.url, r.status])).toEqual([
      // Same-origin calls as paths; another origin keeps its host.
      ["GET", "/api/orders/7", 200],
      ["POST", "https://other.example.com/missing", 404],
      ["GET", "/boom", 0],
    ]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.requests[0].page_route).toBe("/orders/:id");
  });

  it("times an in-app navigation until its requests settle", async () => {
    window.history.pushState(null, "", "/orders/42");
    // What the new route loads.
    await fetch("/api/orders/42");
    await wait(400);

    monitor!.flush(false);
    await wait(0);
    const views = sent[0]!.body.page_views;
    expect(views).toHaveLength(1);
    expect(views[0].kind).toBe("navigation");
    expect(views[0].route).toBe("/orders/:id");
    expect(views[0].duration_ms).toBeGreaterThanOrEqual(0);

    // Same path, new query: not a navigation.
    window.history.replaceState(null, "", "/orders/42?tab=2");
    await wait(300);
    monitor!.flush(false);
    await wait(0);
    expect(sent).toHaveLength(1);
  });

  it("sends the page load with its vitals by beacon when the page goes away", async () => {
    await wait(10);
    vitals.LCP!(metric("LCP", 2100));
    vitals.INP!(metric("INP", 180));
    vitals.CLS!(metric("CLS", 0.02));
    vitals.FCP!(metric("FCP", 900));
    // A back/forward-cache restore is a different view.
    vitals.LCP!(metric("LCP", 99999, "back-forward-cache"));

    window.dispatchEvent(new Event("pagehide"));
    await wait(10);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.beacon).toBe(true);
    expect(sent[0]!.url).toBe("https://errorgap.example.com/api/projects/shop/browser?api_key=flk_test");
    const [load] = sent[0]!.body.page_views;
    expect(load).toMatchObject({
      kind: "load",
      route: "/orders/:id",
      lcp_ms: 2100,
      inp_ms: 180,
      cls: 0.02,
      fcp_ms: 900,
    });
    expect(load.duration_ms).toBeGreaterThanOrEqual(0);
    expect(load).not.toHaveProperty("loaded");

    // The load is sent once.
    window.dispatchEvent(new Event("pagehide"));
    await wait(10);
    expect(sent).toHaveLength(1);
  });

  it("names the load once the app's router has matched", async () => {
    stopPerformance();
    let matched: string | undefined;
    monitor = startPerformance(config(), { routeName: () => matched, flushIntervalMs: 60_000 });
    await wait(50);
    // The router matches after the load event.
    matched = "/orders/:id";
    await wait(250);
    window.dispatchEvent(new Event("pagehide"));
    await wait(10);
    expect(sent[0]!.body.page_views[0].route).toBe("/orders/:id");
  });

  it("measures nothing for a page load outside the sample", () => {
    stopPerformance();
    expect(startPerformance(config(), { sampleRate: 0 })).toBeNull();
  });

  it("puts fetch and history back when stopped", () => {
    stopPerformance();
    expect(window.fetch).toBe(appFetch);
  });
});
