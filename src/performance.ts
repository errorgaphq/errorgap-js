import { onCLS, onFCP, onINP, onLCP, type Metric } from "web-vitals";
import type { Configuration } from "./configuration.js";

/**
 * Browser performance: full page loads, in-app navigations, Core Web Vitals
 * and the fetch/XHR calls a page makes, sent to Errorgap in small batches.
 *
 * Off unless `init({ performance: ... })` asks for it.
 */
export interface PerformanceOptions {
  /** Share of page loads measured, 0–1. Defaults to 1. */
  sampleRate?: number;
  /**
   * The current route as a template, e.g. `/orders/:id`. Called when a page
   * load or navigation completes. Defaults to `location.pathname`, which the
   * server templates by replacing id-like segments.
   */
  routeName?: () => string | null | undefined;
  /** Time fetch and XMLHttpRequest calls. Defaults to true. */
  trackRequests?: boolean;
  /** How often buffered timings are sent, in ms. Defaults to 10 000. */
  flushIntervalMs?: number;
}

export interface PageViewTiming {
  kind: "load" | "navigation";
  route: string;
  duration_ms: number;
  ttfb_ms?: number;
  fcp_ms?: number;
  dom_ready_ms?: number;
  lcp_ms?: number;
  inp_ms?: number;
  cls?: number;
  device: "mobile" | "desktop";
  occurred_at: string;
}

export interface RequestTiming {
  page_route: string;
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  occurred_at: string;
}

const MAX_VIEWS = 200;
const MAX_REQUESTS = 500;
/** A batch is sent early once this many calls are waiting (keepalive bodies are capped at 64 KB). */
const EARLY_FLUSH_REQUESTS = 100;
/** A navigation has settled once no request has been in flight for this long. */
const SETTLE_QUIET_MS = 100;
/** …or after this long regardless (long polling, streams). */
const SETTLE_MAX_MS = 10_000;
const SETTLE_POLL_MS = 50;

type Pending = Partial<PageViewTiming> & { loaded: boolean };

const MONITOR_KEY = Symbol.for("@errorgap/browser/performance");

type MonitorGlobal = typeof globalThis & { [MONITOR_KEY]?: PerformanceMonitor };

/** Start measuring; replaces a monitor started by an earlier `init`. */
export function startPerformance(
  configuration: Configuration,
  options: PerformanceOptions,
): PerformanceMonitor | null {
  stopPerformance();
  if (typeof window === "undefined" || typeof performance === "undefined") return null;
  const rate = options.sampleRate ?? 1;
  if (!(Math.random() < rate)) return null;
  const monitor = new PerformanceMonitor(configuration, options);
  monitor.start();
  (globalThis as MonitorGlobal)[MONITOR_KEY] = monitor;
  return monitor;
}

export function stopPerformance(): void {
  const root = globalThis as MonitorGlobal;
  root[MONITOR_KEY]?.stop();
  delete root[MONITOR_KEY];
}

export class PerformanceMonitor {
  private views: PageViewTiming[] = [];
  private requests: RequestTiming[] = [];
  private load: Pending = { kind: "load", loaded: false };
  private inFlight = 0;
  private lastActivity = 0;
  private lastPath = "";
  private navToken = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restore: Array<() => void> = [];
  private readonly originalFetch: typeof fetch | undefined;
  private readonly ingestPrefix: string;

  constructor(
    private configuration: Configuration,
    private options: PerformanceOptions,
  ) {
    this.originalFetch = typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
    const base = (absolute(configuration.endpoint) ?? configuration.endpoint).replace(/\/+$/, "");
    this.ingestPrefix = `${base}/api/projects/${configuration.projectSlug}/`;
  }

  start(): void {
    this.lastPath = location.pathname;
    this.watchLoad();
    this.watchVitals();
    this.watchNavigations();
    if (this.options.trackRequests !== false) {
      this.patchFetch();
      this.patchXhr();
    }
    this.timer = setInterval(() => this.flush(false), this.options.flushIntervalMs ?? 10_000);
    // After web-vitals registered its own listeners, so on hide it reports
    // the final values first and this sends them.
    const onHidden = () => {
      if (document.visibilityState === "hidden") this.flush(true);
    };
    const onPageHide = () => this.flush(true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    this.restore.push(() => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const undo of this.restore.splice(0).reverse()) undo();
    this.navToken++;
  }

  /** Send what is buffered. `final` is the page going away: use a beacon. */
  flush(final: boolean): void {
    if (final && this.load.loaded) {
      const { loaded: _loaded, ...view } = this.load;
      this.push(this.views, view as PageViewTiming, MAX_VIEWS);
      this.load = { kind: "load", loaded: false };
    }
    if (this.views.length === 0 && this.requests.length === 0) return;
    const config = this.configuration;
    const body = JSON.stringify({
      environment: config.environment,
      release: config.release,
      page_views: this.views.splice(0),
      requests: this.requests.splice(0),
    });
    const url = `${this.ingestPrefix}browser`;
    try {
      if (final && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        // A beacon cannot set headers: the ingest-only key rides in the
        // query, and text/plain needs no CORS preflight.
        const key = config.apiKey ? `?api_key=${encodeURIComponent(config.apiKey)}` : "";
        if (navigator.sendBeacon(url + key, new Blob([body], { type: "text/plain" }))) return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers["x-errorgap-project-key"] = config.apiKey;
      void this.originalFetch?.(url, {
        method: "POST",
        headers,
        body,
        keepalive: true,
        credentials: "omit",
      }).catch(() => undefined);
    } catch {
      // Timings are best effort; never let sending them break the page.
    }
  }

  // ── Page load ──────────────────────────────────────────────────────────────

  private watchLoad(): void {
    const finish = () =>
      // loadEventEnd is only set once the load handlers have returned.
      setTimeout(() => {
        const nav = performance.getEntriesByType?.("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        this.resolveLoadRoute();
        Object.assign(this.load, {
          duration_ms: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : performance.now(),
          ttfb_ms: nav && nav.responseStart > 0 ? nav.responseStart : undefined,
          dom_ready_ms:
            nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : undefined,
          device: device(),
          occurred_at: new Date(performance.timeOrigin || Date.now()).toISOString(),
          loaded: true,
        });
      }, 0);
    if (document.readyState === "complete") {
      finish();
    } else {
      window.addEventListener("load", finish, { once: true });
      this.restore.push(() => window.removeEventListener("load", finish));
    }
  }

  /**
   * The load's route. A router often matches only after the load event (its
   * route code is still loading), so while `routeName` has no answer yet ask
   * again for a few seconds, and fall back to the path.
   */
  private resolveLoadRoute(): void {
    const path = location.pathname;
    this.load.route = path;
    if (!this.options.routeName) return;
    let tries = 0;
    const attempt = () => {
      const name = this.namedRoute();
      if (name) {
        // Only while still on the page that loaded.
        if (location.pathname === path) this.load.route = name;
        return;
      }
      if (++tries < 30 && location.pathname === path) setTimeout(attempt, 100);
    };
    attempt();
  }

  private watchVitals(): void {
    const set = (field: "lcp_ms" | "inp_ms" | "cls" | "fcp_ms") => (metric: Metric) => {
      // A page restored from the back/forward cache is a new view the
      // original load does not describe.
      if (metric.navigationType === "back-forward-cache") return;
      this.load[field] = metric.value;
    };
    onLCP(set("lcp_ms"));
    onINP(set("inp_ms"));
    onCLS(set("cls"));
    onFCP(set("fcp_ms"));
  }

  // ── In-app navigations ─────────────────────────────────────────────────────

  private watchNavigations(): void {
    const check = (path: string) => {
      if (path === this.lastPath) return;
      this.lastPath = path;
      this.startNavigation();
    };
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        // The path the call asked for; only a new path is a navigation, not
        // a query or hash change.
        check(pathOf(args[2]));
        return result;
      };
      this.restore.push(() => {
        history[method] = original;
      });
    }
    const onPop = () => check(location.pathname);
    window.addEventListener("popstate", onPop);
    this.restore.push(() => window.removeEventListener("popstate", onPop));
  }

  /**
   * Time from the route change until the page settles: the next painted
   * frame, and no request in flight for `SETTLE_QUIET_MS` (whatever the new
   * route fetches). A newer navigation abandons this one.
   */
  private startNavigation(): void {
    const token = ++this.navToken;
    const start = performance.now();
    this.lastActivity = start;
    let painted: number | undefined;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16);
    raf(() => raf(() => (painted = performance.now())));

    const poll = () => {
      if (token !== this.navToken) return;
      const now = performance.now();
      const quiet = this.inFlight === 0 && now - this.lastActivity >= SETTLE_QUIET_MS;
      if ((painted !== undefined && quiet) || now - start >= SETTLE_MAX_MS) {
        const end = Math.max(painted ?? now, this.inFlight === 0 ? this.lastActivity : now);
        this.push(
          this.views,
          {
            kind: "navigation",
            route: this.route(),
            duration_ms: Math.max(0, end - start),
            device: device(),
            occurred_at: new Date().toISOString(),
          },
          MAX_VIEWS,
        );
        return;
      }
      setTimeout(poll, SETTLE_POLL_MS);
    };
    setTimeout(poll, SETTLE_POLL_MS);
  }

  // ── Requests ───────────────────────────────────────────────────────────────

  private patchFetch(): void {
    if (typeof window.fetch !== "function") return;
    const original = window.fetch;
    const monitor = this;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = requestUrl(input);
      if (!url || monitor.ignored(url)) return original.call(this, input, init);
      const method = (
        init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const done = monitor.begin(method, url);
      return original.call(this, input, init).then(
        (response) => {
          done(response.status);
          return response;
        },
        (error: unknown) => {
          done(0);
          throw error;
        },
      );
    } as typeof fetch;
    this.restore.push(() => {
      window.fetch = original;
    });
  }

  private patchXhr(): void {
    if (typeof XMLHttpRequest === "undefined") return;
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const monitor = this;
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const resolved = requestUrl(url);
      if (resolved && !monitor.ignored(resolved)) {
        meta.set(this, { method: String(method).toUpperCase(), url: resolved });
      } else {
        meta.delete(this);
      }
      return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const info = meta.get(this);
      if (info) {
        const done = monitor.begin(info.method, info.url);
        this.addEventListener("loadend", () => done(this.status), { once: true });
      }
      return originalSend.call(this, body);
    };
    this.restore.push(() => {
      proto.open = originalOpen;
      proto.send = originalSend;
    });
  }

  /** Track one request; the returned function records its end. */
  private begin(method: string, absoluteUrl: string): (status: number) => void {
    // The page's own API reads as a path; another origin keeps its host.
    const url = absoluteUrl.startsWith(`${location.origin}/`)
      ? absoluteUrl.slice(location.origin.length)
      : absoluteUrl;
    const start = performance.now();
    const page = this.route();
    this.inFlight++;
    this.lastActivity = start;
    let ended = false;
    return (status: number) => {
      if (ended) return;
      ended = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const end = performance.now();
      this.lastActivity = end;
      this.push(
        this.requests,
        {
          page_route: page,
          method,
          url,
          status,
          duration_ms: end - start,
          occurred_at: new Date().toISOString(),
        },
        MAX_REQUESTS,
      );
      if (this.requests.length >= EARLY_FLUSH_REQUESTS) this.flush(false);
    };
  }

  private ignored(url: string): boolean {
    return (
      url.startsWith(this.ingestPrefix) ||
      this.configuration.ignoreOrigins.some((prefix) => url.startsWith(prefix))
    );
  }

  private route(): string {
    return this.namedRoute() ?? location.pathname;
  }

  private namedRoute(): string | undefined {
    try {
      return this.options.routeName?.() || undefined;
    } catch {
      // A throwing routeName falls back to the path.
      return undefined;
    }
  }

  private push<T>(buffer: T[], item: T, max: number): void {
    if (buffer.length < max) buffer.push(item);
  }
}

/** Absolute http(s) URL without its query or fragment, or `undefined`. */
function requestUrl(input: RequestInfo | URL): string | undefined {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input);
  return absolute(raw);
}

function absolute(raw: string): string | undefined {
  try {
    const url = new URL(raw, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Query strings carry tokens and ids; the server never needs them.
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function pathOf(url: string | URL | null | undefined): string {
  if (url == null) return location.pathname;
  try {
    return new URL(String(url), location.href).pathname;
  } catch {
    return location.pathname;
  }
}

function device(): "mobile" | "desktop" {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile ? "mobile" : "desktop";
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches
    ? "mobile"
    : "desktop";
}
