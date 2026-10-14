/**
 * Sends notices to the ingestion API. Queued sends run a few at a time from a bounded queue, so a
 * burst of errors cannot open a connection each or grow without limit. A send
 * that fails on the network or with a 5xx is retried later; a 429 or 503
 * pauses all sending for the server's `Retry-After`.
 */
export interface DeliveryResult {
  status?: number;
  body?: string;
  error?: unknown;
  queued?: boolean;
}

export interface DeliverySettings {
  endpoint: string;
  projectSlug: string | undefined;
  apiKey: string | undefined;
  /** Seconds allowed for each request. */
  timeout: number;
  /** Payloads held while others are being sent; the oldest is dropped when full. */
  queueSize: number;
  userAgent: string;
  warn(message: string): void;
  /** Extra `fetch` options (the browser SDK sets `keepalive`). */
  fetchInit?: Record<string, unknown>;
}

export class RateLimitedError extends Error {
  constructor() {
    super("rate limited by the server, not sent");
    this.name = "RateLimitedError";
  }
}

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const BACKLOG_SIZE = 100;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRY_AFTER_S = 300;

interface Item {
  resource: string;
  payload: unknown;
  attempt: number;
  done?: (result: DeliveryResult) => void;
}

export class Delivery {
  private queue: Item[] = [];
  private inFlight = 0;
  private backlog = 0;
  private pausedUntil = 0;
  private held = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private settings: () => DeliverySettings) {}

  /** Queue a payload and return at once. */
  enqueue(resource: string, payload: unknown): DeliveryResult {
    this.push({ resource, payload, attempt: 1 });
    return { queued: true, status: 202 };
  }

  /** Queue a payload and resolve with the server's answer to its first attempt. */
  send(resource: string, payload: unknown): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      this.push({ resource, payload, attempt: 1, done: resolve });
    });
  }

  /** Resolve once nothing is queued or being sent. Retries waiting for their delay are not waited for. */
  flush(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Hold queued payloads (the browser is offline) or let them go again. */
  hold(held: boolean): void {
    this.held = held;
    if (!held) this.pump();
  }

  paused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  private push(item: Item): void {
    const limit = Math.max(1, this.settings().queueSize || 100);
    if (this.queue.length >= limit) {
      const dropped = this.queue.shift();
      dropped?.done?.({ error: new Error("errorgap queue full, payload dropped") });
      this.settings().warn("[errorgap] queue full, dropped the oldest payload");
    }
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (!this.held && this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift() as Item;
      this.inFlight++;
      void this.post(item.resource, item.payload).then((result) => {
        this.inFlight--;
        item.done?.(result);
        if (retryable(result)) this.retryLater(item);
        if (this.queue.length === 0 && this.inFlight === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const waiter of waiters) waiter();
        }
        this.pump();
      });
    }
  }

  private retryLater(item: Item): void {
    if (item.attempt >= MAX_ATTEMPTS || this.backlog >= BACKLOG_SIZE) return;
    this.backlog++;
    const timer = setTimeout(() => {
      this.backlog--;
      this.push({ resource: item.resource, payload: item.payload, attempt: item.attempt + 1 });
    }, RETRY_DELAY_MS * item.attempt);
    // A pending retry must not keep a finished process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  private async post(resource: string, payload: unknown): Promise<DeliveryResult> {
    if (this.paused()) return { error: new RateLimitedError() };

    const settings = this.settings();
    const base = settings.endpoint.endsWith("/") ? settings.endpoint.slice(0, -1) : settings.endpoint;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": settings.userAgent,
    };
    if (settings.apiKey) headers["x-errorgap-project-key"] = settings.apiKey;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timeoutMs = (settings.timeout > 0 ? settings.timeout : 5) * 1000;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(`${base}/api/projects/${settings.projectSlug}/${resource}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller?.signal,
        ...(settings.fetchInit ?? {}),
      });
      if (response.status === 429 || response.status === 503) {
        this.pauseFor(response.headers?.get?.("retry-after") ?? null);
      }
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      return { status: response.status, body };
    } catch (exception) {
      const message = exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
      settings.warn(`[errorgap] ${resource} delivery error: ${message}`);
      return { error: exception };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private pauseFor(header: string | null): void {
    const parsed = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : DEFAULT_RETRY_AFTER_S;
    const seconds = Math.min(Math.max(parsed, 1), MAX_RETRY_AFTER_S);
    this.pausedUntil = Date.now() + seconds * 1000;
    this.settings().warn(`[errorgap] rate limited, pausing delivery for ${seconds}s`);
  }
}

/**
 * Network failures and 5xx responses are worth another try. A 4xx is not:
 * the server understood and refused, and after a 429 the payload is dropped
 * so a limited project is not sent the same burst again.
 */
export function retryable(result: DeliveryResult): boolean {
  if (result.error instanceof RateLimitedError) return false;
  if (result.error) return true;
  return (result.status ?? 0) >= 500;
}
