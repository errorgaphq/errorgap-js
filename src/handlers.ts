import type { Client } from "./client.js";

interface HandlerState {
  installed: boolean;
  errorHandler: ((event: ErrorEvent) => void) | null;
  rejectionHandler: ((event: PromiseRejectionEvent) => void) | null;
}

const HANDLERS_KEY = Symbol.for("@errorgap/browser/global-handlers");

function handlerState(): HandlerState {
  const root = globalThis as typeof globalThis & { [HANDLERS_KEY]?: HandlerState };
  if (!root[HANDLERS_KEY]) {
    root[HANDLERS_KEY] = {
      installed: false,
      errorHandler: null,
      rejectionHandler: null,
    };
  }
  return root[HANDLERS_KEY];
}

export function installGlobalHandlers(client: Client): void {
  const state = handlerState();
  if (state.installed) return;
  if (typeof window === "undefined") return;
  state.installed = true;

  state.errorHandler = (event: ErrorEvent) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message);
    void client.notify(err, {
      context: { source: "window.onerror" },
    });
  };

  state.rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    void client.notify(reason, {
      context: { source: "unhandledrejection" },
    });
  };

  window.addEventListener("error", state.errorHandler);
  window.addEventListener("unhandledrejection", state.rejectionHandler);
}

export function uninstallGlobalHandlers(): void {
  const state = handlerState();
  if (!state.installed || typeof window === "undefined") return;
  if (state.errorHandler) window.removeEventListener("error", state.errorHandler);
  if (state.rejectionHandler) {
    window.removeEventListener("unhandledrejection", state.rejectionHandler);
  }
  state.errorHandler = null;
  state.rejectionHandler = null;
  state.installed = false;
}
