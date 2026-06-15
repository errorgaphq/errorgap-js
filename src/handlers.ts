import type { Client } from "./client.js";

let installed = false;
let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function installGlobalHandlers(client: Client): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  errorHandler = (event: ErrorEvent) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message);
    void client.notify(err, {
      context: { source: "window.onerror" },
    });
  };

  rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    void client.notify(reason, {
      context: { source: "unhandledrejection" },
    });
  };

  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);
}

export function uninstallGlobalHandlers(): void {
  if (!installed || typeof window === "undefined") return;
  if (errorHandler) window.removeEventListener("error", errorHandler);
  if (rejectionHandler) window.removeEventListener("unhandledrejection", rejectionHandler);
  errorHandler = null;
  rejectionHandler = null;
  installed = false;
}
