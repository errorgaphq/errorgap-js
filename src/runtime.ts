import { Client } from "./client.js";
import { Configuration } from "./configuration.js";

interface RuntimeState {
  configuration: Configuration;
  client: Client;
}

const RUNTIME_KEY = Symbol.for("@errorgap/browser/runtime-state");

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: RuntimeState;
};

/**
 * Package entry points are bundled independently. Keeping state on globalThis
 * ensures the main and React bundles use the same configured client even when
 * a bundler duplicates their shared modules.
 */
export function runtimeState(): RuntimeState {
  const root = globalThis as RuntimeGlobal;
  if (!root[RUNTIME_KEY]) {
    const configuration = new Configuration();
    root[RUNTIME_KEY] = {
      configuration,
      client: new Client(configuration),
    };
  }
  return root[RUNTIME_KEY];
}

export function configureRuntime(configuration: Configuration): RuntimeState {
  const state = runtimeState();
  state.configuration = configuration;
  state.client.configure(configuration);
  return state;
}
