import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Errorgap } from "../src/index.js";
import { describeAgent } from "../src/replay/agent.js";
import { IDLE_TIMEOUT_MS, currentSession, clearSession } from "../src/replay/session.js";
import { serializeSnapshot } from "../src/replay/snapshot.js";
import { MAX_PENDING_EVENTS, RAGE_CLICKS } from "../src/replay/recorder.js";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

interface ServerConfig {
  enabled?: boolean;
  sample_rate?: number;
  capture_snaps?: boolean;
  snap_trigger?: string;
}

const ENDPOINT = "https://errorgap.example.com";
const originalFetch = globalThis.fetch;

function fakeServer(config: ServerConfig, apiStatus = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the string
      }
    }
    sent.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.includes("/sessions/config")) {
      return new Response(
        JSON.stringify({ enabled: true, sample_rate: 1, capture_snaps: false, snap_trigger: "on_error", ...config }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/notices")) return new Response('{"group_id":"group-1"}', { status: 201 });
    if (url.endsWith("/sessions")) return new Response(null, { status: 201 });
    return new Response("{}", { status: apiStatus });
  }) as typeof fetch;
  return sent;
}

function init(): void {
  Errorgap.init({
    endpoint: ENDPOINT,
    projectSlug: "shop",
    apiKey: "egp_key",
    captureGlobals: false,
    async: false,
  });
}

/** Lets pending promises (the config read, deliveries) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function sessionBatches(sent: Sent[]): Sent[] {
  return sent.filter((s) => s.url === `${ENDPOINT}/api/projects/shop/sessions`);
}

function events(sent: Sent[]): Array<{ t: number; type: string; label: string; group_id?: string; has_snap?: boolean }> {
  return sessionBatches(sent).flatMap((b) => b.body.events);
}

beforeEach(() => {
  clearSession();
  document.body.innerHTML = "";
  // happy-dom's history API does not move `location`; set it directly.
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost:3000/checkout");
  // happy-dom's beacon is real; a refused beacon makes the recorder use fetch.
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
});

afterEach(() => {
  Errorgap.init({ captureGlobals: false, replay: false });
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("session replay", () => {
  it("records nothing while replay is off for the project", async () => {
    const sent = fakeServer({ enabled: false });
    init();
    await settle();
    window.history.pushState(null, "", "/cart");
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(sent.filter((s) => s.url.includes("/sessions/config"))).toHaveLength(1);
    expect(sessionBatches(sent)).toHaveLength(0);
  });

  it("reads the settings with the key in the query, and sends the session with the key header once it has an error", async () => {
    const sent = fakeServer({});
    init();
    await settle();

    expect(sent[0]!.url).toBe(`${ENDPOINT}/api/projects/shop/sessions/config?api_key=egp_key`);
    expect(sessionBatches(sent)).toHaveLength(0);

    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();
    const [batch] = sessionBatches(sent);
    expect(batch!.headers["x-errorgap-project-key"]).toBe("egp_key");
    expect(batch!.body.session).toMatchObject({ outcome: "error", device: expect.any(String) });
    expect(batch!.body.events[0]).toEqual({ t: 0, type: "page_load", label: "Loaded /checkout" });
    expect(batch!.body.events.map((e: { type: string }) => e.type)).toContain("error");
  });

  it("records navigations and failed API calls, not its own uploads", async () => {
    const sent = fakeServer({}, 503);
    init();
    await settle();

    window.history.pushState(null, "", "/cart?step=2");
    window.history.pushState(null, "", "/cart?step=3"); // same path: not a navigation
    await fetch("/api/orders/7?token=secret", { method: "post" });
    await Errorgap.notify(new Error("order failed"), { sync: true });
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    const types = events(sent).map((e) => `${e.type}:${e.label}`);
    expect(types).toContain("navigation:Navigated to /cart");
    expect(types).toContain("api_error:POST /api/orders/7 → 503");
    expect(types.filter((t) => t.startsWith("navigation"))).toHaveLength(1);
    expect(types.some((t) => t.includes("/sessions"))).toBe(false);
  });

  it("links a reported error to its group and attaches a masked snapshot", async () => {
    const sent = fakeServer({ capture_snaps: true });
    document.body.innerHTML = `
      <form><input name="card" value="4242424242424242"><textarea>my secret note</textarea></form>
      <p data-errorgap-mask>Ana Lee</p><div data-errorgap-block>internal</div>
      <script>alert(1)</script><button onclick="pay()">Pay</button>`;
    (document.querySelector("input") as HTMLInputElement).value = "typed later";
    init();
    await settle();

    await Errorgap.notify(new TypeError("card is undefined"), { sync: true });
    await settle();

    const all = events(sent);
    const error = all.find((e) => e.type === "error");
    expect(error).toMatchObject({ label: "TypeError: card is undefined", group_id: "group-1" });
    const snapEvent = all.find((e) => e.type === "snapshot");
    expect(snapEvent).toMatchObject({ t: error!.t, has_snap: true });

    const snapshot = sessionBatches(sent).flatMap((b) => b.body.snapshots)[0];
    expect(snapshot.t).toBe(error!.t);
    for (const leaked of ["4242424242424242", "typed later", "my secret note", "Ana Lee", "internal", "alert(1)", "onclick"]) {
      expect(snapshot.html).not.toContain(leaked);
    }
    expect(snapshot.html).toContain("Pay");
    expect(sessionBatches(sent).slice(-1)[0]!.body.session.outcome).toBe("error");
  });

  it("sends no snapshot when the project does not capture them", async () => {
    const sent = fakeServer({ capture_snaps: false });
    init();
    await settle();
    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();

    expect(events(sent).some((e) => e.type === "error")).toBe(true);
    expect(events(sent).some((e) => e.type === "snapshot")).toBe(false);
    expect(sessionBatches(sent).flatMap((b) => b.body.snapshots)).toHaveLength(0);
    expect(Errorgap.captureSnapshot()).toBe(false);
  });

  it("records a rage click once per burst", async () => {
    const sent = fakeServer({});
    document.body.innerHTML = `<div id="promo">Apply code</div>`;
    init();
    await settle();

    const el = document.getElementById("promo")!;
    for (let i = 0; i < RAGE_CLICKS + 2; i++) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Errorgap.notify(new Error("promo failed"), { sync: true });
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    const rage = events(sent).filter((e) => e.type === "rage_click");
    expect(rage).toHaveLength(1);
    expect(rage[0]!.label).toMatch(/^"Apply code" clicked 5× in \d+\.\ds$/);
  });

  it("ends with an exit event sent by beacon on page hide", async () => {
    const sent = fakeServer({});
    const beacons: Array<{ url: string; body: string }> = [];
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (url: string, data: Blob) => {
        void data.text().then((body) => beacons.push({ url, body }));
        return true;
      },
    });
    init();
    await settle();
    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe(`${ENDPOINT}/api/projects/shop/sessions?api_key=egp_key`);
    const body = JSON.parse(beacons[0]!.body);
    expect(body.events[body.events.length - 1]).toMatchObject({ type: "exit", label: "Left /checkout" });
    expect(body.session.outcome).toBe("error");
    // The error went up by fetch; only the exit rode the beacon.
    expect(sent.filter((s) => s.method === "POST" && s.url.endsWith("/sessions"))).toHaveLength(1);
  });

  it("keeps the sampling decision for the session and reads the settings once", async () => {
    const sent = fakeServer({ sample_rate: 0 });
    init();
    await settle();
    init(); // a second page load in the same tab
    await settle();

    expect(sent.filter((s) => s.url.includes("/sessions/config"))).toHaveLength(1);
    expect(sessionBatches(sent)).toHaveLength(0);
  });

  it("sends nothing for a session that never has an error", async () => {
    const sent = fakeServer({});
    init();
    await settle();
    window.history.pushState(null, "", "/cart");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(sessionBatches(sent)).toHaveLength(0);
  });

  it("carries the pages before an error into the session", async () => {
    const sent = fakeServer({});
    init();
    await settle();
    window.dispatchEvent(new Event("pagehide")); // leaving /checkout, no error yet

    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost:3000/pay");
    init(); // the next page in the same tab
    await settle();
    expect(sessionBatches(sent)).toHaveLength(0);

    await Errorgap.notify(new Error("payment failed"), { sync: true });
    await settle();
    const labels = events(sent).map((e) => `${e.type}:${e.label}`);
    expect(labels.slice(0, 3)).toEqual(["page_load:Loaded /checkout", "exit:Left /checkout", "page_load:Loaded /pay"]);
    expect(labels).toContain("error:Error: payment failed");
    expect(new Set(sessionBatches(sent).map((b) => b.body.session.id)).size).toBe(1);
  });

  it("holds only the most recent events before an error", async () => {
    const sent = fakeServer({});
    init();
    await settle();
    for (let i = 0; i < MAX_PENDING_EVENTS + 50; i++) window.history.pushState(null, "", `/item/${i}`);
    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();

    const all = events(sent);
    const before = all.filter((e) => e.type !== "error");
    expect(before).toHaveLength(MAX_PENDING_EVENTS);
    expect(before[0]!.label).toBe("Navigated to /item/50");
    expect(before.some((e) => e.type === "page_load")).toBe(false);
  });

  it("can be turned off in the app", async () => {
    const sent = fakeServer({});
    Errorgap.init({ endpoint: ENDPOINT, projectSlug: "shop", apiKey: "k", captureGlobals: false, replay: false });
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe("replay session", () => {
  it("starts a new session after 30 idle minutes", () => {
    const first = currentSession(1_000);
    expect(currentSession(1_000 + IDLE_TIMEOUT_MS - 1).id).toBe(first.id);
    expect(currentSession(1_000 + 2 * IDLE_TIMEOUT_MS).id).not.toBe(first.id);
  });
});

describe("snapshot", () => {
  it("adds a base for relative assets and drops javascript: links", () => {
    document.head.innerHTML = `<link rel="stylesheet" href="/app.css">`;
    document.body.innerHTML = `<a href="javascript:steal()">x</a><a href="/ok">ok</a>`;
    const html = serializeSnapshot()!;
    expect(html.startsWith("<!doctype html><html")).toBe(true);
    expect(html).toContain(`<base href="${location.origin}/">`);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="/ok"');
  });

  it("is skipped when it would be over 1 MiB", () => {
    document.body.innerHTML = `<p>${"x".repeat(1024 * 1024 + 10)}</p>`;
    expect(serializeSnapshot()).toBeNull();
  });
});

describe("agent", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      { browser: "Chrome 129", os: "macOS 10.15", device: "Desktop" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      { browser: "Safari 17", os: "iOS 17", device: "Mobile" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      { browser: "Edge 129", os: "Windows", device: "Desktop" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      { browser: "Chrome 129", os: "Android 14", device: "Tablet" },
    ],
  ])("reads %s", (ua, expected) => {
    expect(describeAgent(ua)).toEqual(expected);
  });
});
