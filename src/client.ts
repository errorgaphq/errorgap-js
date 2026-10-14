import type { Configuration } from "./configuration.js";
import { RemoteSettings } from "./remote-settings.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { enrichBacktrace } from "./source-maps.js";
import { replayErrorStarted } from "./replay/index.js";
import { VERSION } from "./version.js";
import { Delivery, type DeliveryResult as SendResult } from "./delivery.js";
import { Deduper, isNoise } from "./noise.js";
import type { NoticeUser } from "./notice.js";

export interface DeliveryResult extends SendResult {
  sampled?: boolean;
  /** Not sent: `noise`, `duplicate`, `beforeNotify` or `environment`. */
  dropped?: string;
}

export class Client {
  private pending = new Set<Promise<unknown>>();
  private deduper = new Deduper();
  private user: NoticeUser | null = null;
  private onlineListening = false;
  /** What errorgap wants this app to send (the project's remote settings). */
  readonly remote = new RemoteSettings(() => this.configuration);
  private delivery = new Delivery(() => ({
    endpoint: this.configuration.endpoint,
    projectSlug: this.configuration.projectSlug,
    apiKey: this.configuration.apiKey,
    timeout: this.configuration.timeout,
    queueSize: this.configuration.queueSize,
    userAgent: `errorgap-browser/${VERSION}`,
    warn: (message) => this.configuration.logger?.warn(message),
    // keepalive lets a notice sent during unload finish; credentials are
    // never needed, the project key authenticates.
    fetchInit: { keepalive: true, credentials: "omit" },
  }));

  constructor(private configuration: Configuration) {}

  /** Name the signed-in user on every later notice; `null` clears it. */
  setUser(user: NoticeUser | null): void {
    this.user = user;
  }

  configure(configuration: Configuration): void {
    this.configuration = configuration;
  }

  async notify(
    error: unknown,
    options: NoticeContext & { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    // Tracked from the first moment, so `flush()` right after `notify()`
    // waits for the notice even while it is still being prepared.
    const operation = this.process(error, options);
    this.track(operation);
    if (options.sync || !this.configuration.async) return operation;

    const early = await Promise.race([operation, Promise.resolve(undefined)]);
    return early ?? { queued: true, status: 202 };
  }

  private async process(error: unknown, options: NoticeContext): Promise<DeliveryResult> {
    let replayDone: (groupId?: string) => void = () => undefined;
    try {
      this.configuration.validate();
      if (this.configuration.ignoreEnvironments.includes(this.configuration.environment)) {
        return { status: 202, dropped: "environment" };
      }
      if (!this.remote.enabled("errors")) return { status: 202, dropped: "remote settings" };
      this.watchConnection();
      const err = coerceError(error);
      // The session replay timeline shows every error, sampled out or not;
      // a delivered one is linked to its error group.
      replayDone = replayErrorStarted(`${err.name || "Error"}: ${err.message}`);
      if (!shouldSample(this.configuration.sampleRate)) {
        replayDone();
        return { sampled: true };
      }
      const built = buildNotice(err, this.configuration, { user: this.user, ...options });
      if (this.configuration.ignoreNoise && isNoise(built)) {
        replayDone();
        return { status: 202, dropped: "noise" };
      }
      if (this.deduper.duplicate(built, this.configuration.dedupeWindowMs)) {
        replayDone();
        return { status: 202, dropped: "duplicate" };
      }
      const notice = await this.runHook(built);
      if (!notice) {
        replayDone();
        return { status: 202, dropped: "beforeNotify" };
      }
      const result = await this.prepareAndDeliver(notice, this.configuration);
      replayDone(groupIdOf(result));
      return result;
    } catch (exception) {
      replayDone();
      this.log(exception);
      return { error: exception };
    }
  }

  async deliver(
    notice: NoticePayload,
    _configuration: Configuration = this.configuration,
  ): Promise<DeliveryResult> {
    return this.delivery.send("notices", notice);
  }

  /**
   * A hook that throws is logged and skipped: a bug in a filter must not
   * lose the error it was filtering.
   */
  private async runHook(notice: NoticePayload): Promise<NoticePayload | null> {
    const hook = this.configuration.beforeNotify;
    if (!hook) return notice;
    try {
      const result = await hook(notice);
      if (result === false || result === null) return null;
      return result && typeof result === "object" && Array.isArray(result.errors) ? result : notice;
    } catch (exception) {
      this.log(exception);
      return notice;
    }
  }

  /** While the browser is offline notices wait in the queue; they go out when it is back. */
  private watchConnection(): void {
    if (this.onlineListening || typeof window === "undefined") return;
    if (typeof window.addEventListener !== "function") return;
    this.onlineListening = true;
    window.addEventListener("offline", () => this.delivery.hold(true));
    window.addEventListener("online", () => this.delivery.hold(false));
    if (typeof navigator !== "undefined" && navigator.onLine === false) this.delivery.hold(true);
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending));
    }
  }

  private async prepareAndDeliver(
    notice: NoticePayload,
    configuration: Configuration,
  ): Promise<DeliveryResult> {
    if (configuration.sourceMaps) {
      for (const error of notice.errors) {
        error.backtrace = await enrichBacktrace(error.backtrace);
      }
    }
    return this.deliver(notice, configuration);
  }

  private track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => undefined);
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
  }

  private log(exception: unknown): void {
    const logger = this.configuration.logger;
    if (!logger) return;
    const message =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception);
    logger.warn(`[errorgap] ${message}`);
  }
}

function groupIdOf(result: DeliveryResult): string | undefined {
  if (!result.body) return undefined;
  try {
    const parsed = JSON.parse(result.body) as { group_id?: unknown };
    return typeof parsed.group_id === "string" ? parsed.group_id : undefined;
  } catch {
    return undefined;
  }
}

function noticesUrl(configuration: Configuration): string {
  const base = configuration.endpoint.endsWith("/")
    ? configuration.endpoint.slice(0, -1)
    : configuration.endpoint;
  return `${base}/api/projects/${configuration.projectSlug}/notices`;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function shouldSample(rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

function coerceError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error && typeof error === "object") {
    const obj = error as { message?: unknown; name?: unknown };
    const err = new Error(
      typeof obj.message === "string" ? obj.message : JSON.stringify(error),
    );
    if (typeof obj.name === "string") err.name = obj.name;
    return err;
  }
  return new Error(String(error));
}
