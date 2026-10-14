import type { Configuration } from "./configuration.js";
import { VERSION } from "./version.js";

export type RemoteKind = "errors" | "apm" | "logs";

const FIELDS: Record<RemoteKind, string> = {
  errors: "errors_enabled",
  apm: "apm_enabled",
  logs: "logs_enabled",
};
const DEFAULT_INTERVAL_S = 600;
const MIN_INTERVAL_S = 60;

/**
 * The project's remote settings: what errorgap wants this app to send.
 * Someone can turn errors, performance data or logs off for a project in
 * errorgap (Project settings › What SDKs send) and running apps follow within
 * a poll interval, with no deploy or release.
 *
 * Read from `GET /api/projects/:slug/config` in the background. Until the
 * first answer, and whenever errorgap cannot be reached, everything stays on.
 */
export class RemoteSettings {
  private settings: Record<string, unknown> = {};
  private intervalSeconds = DEFAULT_INTERVAL_S;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(private configuration: () => Configuration) {}

  /** False only when errorgap has said to stop sending this kind of data. */
  enabled(kind: RemoteKind): boolean {
    if (!this.configuration().remoteSettings) return true;
    this.start();
    return this.settings[FIELDS[kind]] !== false;
  }

  /** Fetch now. Resolves with whether the settings could be read. */
  async refresh(): Promise<boolean> {
    const configuration = this.configuration();
    if (!configuration.projectSlug || !configuration.endpoint) return false;
    const base = configuration.endpoint.endsWith("/")
      ? configuration.endpoint.slice(0, -1)
      : configuration.endpoint;
    const headers: Record<string, string> = { "user-agent": `errorgap-browser/${VERSION}` };
    if (configuration.apiKey) headers["x-errorgap-project-key"] = configuration.apiKey;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const seconds = configuration.timeout > 0 ? configuration.timeout : 5;
    const timeout = controller ? setTimeout(() => controller.abort(), seconds * 1000) : undefined;
    try {
      const response = await fetch(`${base}/api/projects/${configuration.projectSlug}/config`, {
        headers,
        signal: controller?.signal,
      });
      if (response.status !== 200) return false;
      const body = (await response.json()) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return false;
      this.settings = body;
      const interval = Number(body.poll_interval_seconds);
      this.intervalSeconds = Number.isFinite(interval) && interval >= MIN_INTERVAL_S
        ? interval
        : DEFAULT_INTERVAL_S;
      return true;
    } catch {
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /** Stop polling (tests, or a reconfigured client). */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const poll = () => {
      void this.refresh().finally(() => {
        if (!this.started) return;
        this.timer = setTimeout(poll, this.intervalSeconds * 1000);
        // Browsers and apps have no process to keep alive.
      });
    };
    poll();
  }
}
