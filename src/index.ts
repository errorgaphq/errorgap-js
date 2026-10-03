import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult } from "./client.js";
import { installGlobalHandlers, uninstallGlobalHandlers } from "./handlers.js";
import type { NoticeContext } from "./notice.js";
import { configureRuntime, runtimeState } from "./runtime.js";
import { startPerformance, stopPerformance, type PerformanceOptions } from "./performance.js";
import { VERSION } from "./version.js";

export type { ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload } from "./notice.js";
export type { BacktraceFrame } from "./backtrace.js";
export type { DeliveryResult } from "./client.js";
export type { PerformanceOptions, PageViewTiming, RequestTiming } from "./performance.js";
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
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, performance = false, ...rest } = options;
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
}

function notify(
  error: unknown,
  options: NoticeContext & { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return runtimeState().client.notify(error, options);
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
  flush,
  configuration: getConfiguration,
  client: getClient,
  VERSION,
};

export { init, notify, flush };
