import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult } from "./client.js";
import { installGlobalHandlers, uninstallGlobalHandlers } from "./handlers.js";
import type { NoticeContext } from "./notice.js";
import { configureRuntime, runtimeState } from "./runtime.js";
import { VERSION } from "./version.js";

export type { ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload } from "./notice.js";
export type { BacktraceFrame } from "./backtrace.js";
export type { DeliveryResult } from "./client.js";
export { Configuration } from "./configuration.js";
export { Client } from "./client.js";
export { VERSION };

export interface InitOptions extends ConfigurationInput {
  /**
   * Install `error` and `unhandledrejection` window listeners.
   * Defaults to `true` when `window` is available.
   */
  captureGlobals?: boolean;
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, ...rest } = options;
  const { client } = configureRuntime(new Configuration(rest));
  if (captureGlobals) {
    installGlobalHandlers(client);
  } else {
    uninstallGlobalHandlers();
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
