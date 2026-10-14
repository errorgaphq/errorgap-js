import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult } from "./client.js";
import { installGlobalHandlers, uninstallGlobalHandlers } from "./handlers.js";
import type { NoticeContext, NoticeUser } from "./notice.js";
import { configureRuntime, runtimeState } from "./runtime.js";
import { startPerformance, stopPerformance, type PerformanceOptions } from "./performance.js";
import { captureReplaySnapshot, startReplay, stopReplay, type ReplayOptions } from "./replay/index.js";
import { VERSION } from "./version.js";

export type { BeforeNotify, ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload, NoticeUser } from "./notice.js";
export type { FilterKey } from "./filter.js";
export type { BacktraceFrame } from "./backtrace.js";
export type { DeliveryResult } from "./client.js";
export type { PerformanceOptions, PageViewTiming, RequestTiming } from "./performance.js";
export type { ReplayOptions } from "./replay/index.js";
export { Configuration } from "./configuration.js";
export { Client } from "./client.js";
export { VERSION };

export interface InitOptions extends ConfigurationInput {
  /**
   * Install `error` and `unhandledrejection` window listeners.
   * Defaults to `true` when `window` is available.
   */
  captureGlobals?: boolean;
  /**
   * Measure page loads, in-app navigations, Core Web Vitals and fetch/XHR
   * calls. `true` for the defaults, or options. Off by default.
   */
  performance?: boolean | PerformanceOptions;
  /**
   * Session replay. On by default, but it records only what the project's
   * replay settings allow (Settings → Session replay): nothing while replay is
   * off there, and a sampled share of sessions while it is on. `false` turns
   * it off in this app whatever the settings say.
   */
  replay?: boolean | ReplayOptions;
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, performance = false, replay = true, ...rest } = options;
  const { client, configuration } = configureRuntime(new Configuration(rest));
  if (captureGlobals) {
    installGlobalHandlers(client);
  } else {
    uninstallGlobalHandlers();
  }
  if (performance) {
    try {
      configuration.validate();
      startPerformance(configuration, performance === true ? {} : performance);
    } catch (error) {
      configuration.logger?.warn(
        `[errorgap] performance not started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    stopPerformance();
  }
  if (replay) {
    try {
      configuration.validate();
      startReplay(configuration, replay === true ? {} : replay);
    } catch (error) {
      configuration.logger?.warn(
        `[errorgap] session replay not started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    stopReplay();
  }
}

/**
 * Take a DOM snapshot for session replay now (inputs blanked, `data-errorgap-*`
 * masking applied). Only when this session is being recorded and the project
 * captures snapshots; returns whether one was taken.
 */
function captureSnapshot(): boolean {
  return captureReplaySnapshot();
}

function notify(
  error: unknown,
  options: NoticeContext & { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return runtimeState().client.notify(error, options);
}

/**
 * Name the signed-in user on every later notice (`session.user_id`,
 * `session.user_email`). Call with `null` on sign-out.
 */
function setUser(user: NoticeUser | null): void {
  runtimeState().client.setUser(user);
}

function flush(): Promise<void> {
  return runtimeState().client.flush();
}

function getConfiguration(): Configuration {
  return runtimeState().configuration;
}

function getClient(): Client {
  return runtimeState().client;
}

export const Errorgap = {
  init,
  notify,
  setUser,
  flush,
  configuration: getConfiguration,
  client: getClient,
  captureSnapshot,
  VERSION,
};

export { init, notify, setUser, flush, captureSnapshot };
