import type { Configuration } from "../configuration.js";
import { pathOf, requestUrl } from "../performance.js";
import { describeAgent, type AgentInfo } from "./agent.js";
import { currentSession, save, type RecordingDecision, type ReplaySession } from "./session.js";
import { serializeSnapshot } from "./snapshot.js";

/**
 * Session replay: a light timeline of what the visitor did and saw (page
 * loads, navigations, failed API calls, errors, rage and dead clicks) plus,
 * when the project captures them, masked DOM snapshots. No video and no
 * keystrokes.
 *
 * Whether anything is recorded is the project's call: the recorder reads the
 * project's replay settings once per session and records a sampled share of
 * sessions only while replay is on.
 */
export interface ReplayOptions {
  /** How often recorded events are sent, in ms. Defaults to 10 000. */
  flushIntervalMs?: number;
}

export interface ReplayEvent {
  t: number;
  type: string;
  label: string;
  group_id?: string;
  has_snap?: boolean;
}

interface Snapshot {
  t: number;
  html: string;
  size_bytes: number;
}

type State = "pending" | "recording" | "off";

/** SDKs send at most this many events per batch (the server keeps 500). */
export const MAX_BATCH_EVENTS = 200;
/** Events held while the project's settings are being read, or while offline. */
const MAX_BUFFERED_EVENTS = 1000;
const MAX_LABEL = 200;
export const RAGE_CLICKS = 5;
export const RAGE_WINDOW_MS = 2000;
export const DEAD_CLICK_MS = 1000;
/** `keepalive` and beacon bodies are capped at 64 KB by browsers. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

const INTERACTIVE =
  "a[href],button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=''],[contenteditable=true]";

export class ReplayRecorder {
  private session!: ReplaySession;
  private agent!: AgentInfo;
  private state: State = "pending";
  private events: ReplayEvent[] = [];
  private snapshots: Snapshot[] = [];
  private restore: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPath = "";
  private clickTarget: Element | null = null;
  private clickTimes: number[] = [];
  private rageReported = false;
  private deadWatch: (() => void) | undefined;
  private readonly originalFetch: typeof fetch | undefined;
  private readonly base: string;

  constructor(
    private configuration: Configuration,
    private options: ReplayOptions = {},
  ) {
    this.originalFetch = typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
    const endpoint = configuration.endpoint.replace(/\/+$/, "");
    this.base = `${endpoint}/api/projects/${configuration.projectSlug}`;
  }

  get recording(): boolean {
    return this.state === "recording";
  }

  start(): void {
    this.session = currentSession();
    this.agent = describeAgent();
    this.lastPath = location.pathname;
    this.push({ type: "page_load", label: `Loaded ${location.pathname}` });
    this.watchNavigations();
    this.watchRequests();
    this.watchClicks();
    this.watchPageHide();
    if (this.session.decision) {
      this.apply(this.session.decision);
    } else {
      void this.decide();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deadWatch?.();
    for (const undo of this.restore.splice(0).reverse()) undo();
    this.state = "off";
  }

  /**
   * An error is being reported. Returns the function the client calls once
   * the server has answered, with the error group's id when it has one.
   */
  errorStarted(label: string): (groupId?: string) => void {
    if (this.state === "off") return () => undefined;
    const t = this.offset();
    this.session.hadError = true;
    save(this.session);
    const snapshot = this.wantsSnapshot("on_error") ? this.takeSnapshot(t) : undefined;
    let done = false;
    return (groupId?: string) => {
      if (done || this.state === "off") return;
      done = true;
      this.push({ t, type: "error", label: trim(label), ...(groupId ? { group_id: groupId } : {}) });
      if (snapshot) this.attachSnapshot(t, snapshot, "on error");
      if (this.state === "recording") this.flush(false);
    };
  }

  /** `Errorgap.captureSnapshot()`: a snapshot now, when the project captures them. */
  captureSnapshot(): boolean {
    if (!this.wantsSnapshot("manual")) return false;
    const t = this.offset();
    const html = this.takeSnapshot(t);
    if (!html) return false;
    this.attachSnapshot(t, html, "manual");
    this.flush(false);
    return true;
  }

  /** Send what is recorded. `final` is the page going away: use a beacon. */
  flush(final: boolean): void {
    if (this.state !== "recording") return;
    do {
      const events = this.events.splice(0, MAX_BATCH_EVENTS);
      const sentOffsets = new Set(events.map((e) => e.t));
      const snapshots = this.snapshots.filter((s) => sentOffsets.has(s.t));
      this.snapshots = this.snapshots.filter((s) => !sentOffsets.has(s.t));
      if (events.length === 0 && !final) return;
      this.send(this.batch(events, snapshots, final), final);
      final = false;
    } while (this.events.length > 0);
  }

  // ── Recording decision ─────────────────────────────────────────────────────

  private async decide(): Promise<void> {
    const key = this.configuration.apiKey ? `?api_key=${encodeURIComponent(this.configuration.apiKey)}` : "";
    try {
      // The key in the query keeps this a simple request (no CORS preflight).
      const res = await this.originalFetch?.(`${this.base}/sessions/config${key}`, { credentials: "omit" });
      if (!res || !res.ok) throw new Error(`replay config: HTTP ${res?.status ?? "?"}`);
      const config = (await res.json()) as {
        enabled?: boolean;
        sample_rate?: number;
        capture_snaps?: boolean;
        snap_trigger?: string;
      };
      const rate = typeof config.sample_rate === "number" ? config.sample_rate : 0;
      const decision: RecordingDecision = {
        record: config.enabled === true && Math.random() < rate,
        captureSnaps: config.capture_snaps === true,
        snapTrigger: config.snap_trigger ?? "on_error",
      };
      this.session.decision = decision;
      save(this.session);
      this.apply(decision);
    } catch {
      // Settings unreadable (offline, wrong key): record nothing on this page
      // and ask again on the next one.
      this.stop();
    }
  }

  private apply(decision: RecordingDecision): void {
    if (this.state === "off") return;
    if (!decision.record) {
      this.stop();
      this.events = [];
      this.snapshots = [];
      return;
    }
    if (!decision.captureSnaps) {
      this.snapshots = [];
      this.events = this.events.filter((e) => e.type !== "snapshot");
      for (const e of this.events) delete e.has_snap;
    }
    this.state = "recording";
    this.timer = setInterval(() => this.flush(false), this.options.flushIntervalMs ?? 10_000);
    this.flush(false);
  }

  private wantsSnapshot(trigger: string): boolean {
    if (this.state === "off") return false;
    const decision = this.session.decision;
    // Before the settings are known, take it: it is dropped if they say no.
    if (!decision) return trigger !== "manual";
    return decision.captureSnaps && (trigger === "manual" || decision.snapTrigger === trigger);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private push(event: Omit<ReplayEvent, "t"> & { t?: number }): void {
    if (this.state === "off") return;
    if (this.events.length >= MAX_BUFFERED_EVENTS) return;
    this.events.push({ ...event, t: event.t ?? this.offset(), label: trim(event.label) });
    this.session.lastActivity = Date.now();
    save(this.session);
  }

  private takeSnapshot(_t: number): string | undefined {
    try {
      return serializeSnapshot() ?? undefined;
    } catch {
      return undefined;
    }
  }

  private attachSnapshot(t: number, html: string, why: string): void {
    this.snapshots.push({ t, html, size_bytes: byteLength(html) });
    this.push({ t, type: "snapshot", label: `DOM snapshot captured (${why})`, has_snap: true });
  }

  private watchNavigations(): void {
    const check = (path: string) => {
      if (path === this.lastPath) return;
      this.lastPath = path;
      this.push({ type: "navigation", label: `Navigated to ${path}` });
    };
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
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

  private watchRequests(): void {
    const recorder = this;
    const failed = (method: string, url: string, status: number) => {
      if (status !== 0 && status < 500) return;
      const shown = url.startsWith(`${location.origin}/`) ? url.slice(location.origin.length) : url;
      recorder.push({
        type: "api_error",
        label: `${method} ${shown} → ${status === 0 ? "failed" : status}`,
      });
    };

    if (typeof window.fetch === "function") {
      const original = window.fetch;
      window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const url = requestUrl(input);
        if (!url || recorder.ignored(url)) return original.call(this, input, init);
        const method = (
          init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        return original.call(this, input, init).then(
          (response) => {
            failed(method, url, response.status);
            return response;
          },
          (error: unknown) => {
            failed(method, url, 0);
            throw error;
          },
        );
      } as typeof fetch;
      this.restore.push(() => {
        window.fetch = original;
      });
    }

    if (typeof XMLHttpRequest !== "undefined") {
      const proto = XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        const resolved = requestUrl(url);
        if (resolved && !recorder.ignored(resolved)) {
          meta.set(this, { method: String(method).toUpperCase(), url: resolved });
        } else {
          meta.delete(this);
        }
        return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof proto.open;
      proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const info = meta.get(this);
        if (info) {
          this.addEventListener("loadend", () => failed(info.method, info.url, this.status), { once: true });
        }
        return originalSend.call(this, body);
      };
      this.restore.push(() => {
        proto.open = originalOpen;
        proto.send = originalSend;
      });
    }
  }

  private watchClicks(): void {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      this.trackRage(target);
      this.trackDead(target);
    };
    document.addEventListener("click", onClick, true);
    this.restore.push(() => document.removeEventListener("click", onClick, true));
  }

  private trackRage(target: Element): void {
    const now = Date.now();
    if (target !== this.clickTarget) {
      this.clickTarget = target;
      this.clickTimes = [];
      this.rageReported = false;
    }
    this.clickTimes = this.clickTimes.filter((at) => now - at <= RAGE_WINDOW_MS);
    this.clickTimes.push(now);
    if (this.clickTimes.length >= RAGE_CLICKS && !this.rageReported) {
      this.rageReported = true;
      const secs = ((now - this.clickTimes[0]!) / 1000).toFixed(1);
      const t = this.offset();
      this.push({
        t,
        type: "rage_click",
        label: `${describe(target)} clicked ${this.clickTimes.length}× in ${secs}s`,
      });
      if (this.wantsSnapshot("on_rage_click")) {
        const html = this.takeSnapshot(t);
        if (html) this.attachSnapshot(t, html, "on rage click");
      }
    }
    if (this.clickTimes.length === 1) this.rageReported = false;
  }

  /**
   * A click on something that looks clickable (pointer cursor, not a real
   * control) that changes nothing on the page within a second.
   */
  private trackDead(target: Element): void {
    if (this.deadWatch || target.closest(INTERACTIVE)) return;
    let pointer = false;
    try {
      pointer = getComputedStyle(target).cursor === "pointer";
    } catch {
      pointer = false;
    }
    if (!pointer || typeof MutationObserver === "undefined") return;
    const path = location.pathname;
    let changed = false;
    const observer = new MutationObserver(() => {
      changed = true;
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setTimeout(() => {
      finish();
      if (!changed && location.pathname === path) {
        this.push({ type: "dead_click", label: `Click on ${describe(target)} did nothing` });
      }
    }, DEAD_CLICK_MS);
    const finish = () => {
      clearTimeout(timer);
      observer.disconnect();
      this.deadWatch = undefined;
    };
    this.deadWatch = finish;
  }

  private watchPageHide(): void {
    const onHidden = () => {
      if (document.visibilityState === "hidden") this.flush(true);
    };
    const onPageHide = () => {
      this.push({ type: "exit", label: `Left ${location.pathname}` });
      this.flush(true);
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    this.restore.push(() => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    });
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  private batch(events: ReplayEvent[], snapshots: Snapshot[], final: boolean): string {
    const now = Date.now();
    return JSON.stringify({
      session: {
        id: this.session.id,
        handle: null,
        browser: this.agent.browser,
        os: this.agent.os,
        device: this.agent.device,
        started_at: new Date(this.session.startedAt).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_sec: this.offset(now),
        outcome: this.session.hadError ? "error" : final ? "completed" : "abandoned",
      },
      events,
      snapshots,
    });
  }

  private send(body: string, final: boolean): void {
    const url = `${this.base}/sessions`;
    const small = byteLength(body) <= KEEPALIVE_MAX_BYTES;
    try {
      if (final && small && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        // A beacon cannot set headers: the ingest-only key rides in the
        // query, and text/plain needs no CORS preflight.
        const key = this.configuration.apiKey ? `?api_key=${encodeURIComponent(this.configuration.apiKey)}` : "";
        if (navigator.sendBeacon(url + key, new Blob([body], { type: "text/plain" }))) return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.configuration.apiKey) headers["x-errorgap-project-key"] = this.configuration.apiKey;
      void this.originalFetch?.(url, {
        method: "POST",
        headers,
        body,
        keepalive: small,
        credentials: "omit",
      })
        .then((res) => {
          // Replay was switched off, or the session belongs elsewhere: stop.
          if (res.status === 204 || res.status === 401 || res.status === 404 || res.status === 409) {
            if (this.session.decision) {
              this.session.decision = { ...this.session.decision, record: false };
              save(this.session);
            }
            this.stop();
          }
        })
        .catch(() => undefined);
    } catch {
      // Replay is best effort; never let sending it break the page.
    }
  }

  private ignored(url: string): boolean {
    return (
      url.startsWith(`${this.base}/`) ||
      this.configuration.ignoreOrigins.some((prefix) => url.startsWith(prefix))
    );
  }

  private offset(now: number = Date.now()): number {
    return Math.max(0, Math.round((now - this.session.startedAt) / 1000));
  }
}

function describe(el: Element): string {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return `"${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`;
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function trim(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

function byteLength(text: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length * 3;
}
