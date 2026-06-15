import type { Configuration } from "./configuration.js";
import { parseBacktrace, type BacktraceFrame } from "./backtrace.js";
import { filterParams } from "./filter.js";
import { VERSION } from "./version.js";

export interface NoticeContext {
  context?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  session?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface NoticePayload {
  project_id?: string;
  received_at: string;
  errors: Array<{
    type: string;
    message: string;
    backtrace: BacktraceFrame[];
  }>;
  context: Record<string, unknown>;
  environment: Record<string, unknown>;
  session: Record<string, unknown>;
  params: Record<string, unknown>;
}

export function buildNotice(
  error: Error,
  configuration: Configuration,
  options: NoticeContext = {},
): NoticePayload {
  return {
    project_id: configuration.projectId,
    received_at: new Date().toISOString(),
    errors: [
      {
        type: errorType(error),
        message: String(error.message ?? ""),
        backtrace: parseBacktrace(error),
      },
    ],
    context: {
      notifier: "errorgap-browser",
      notifier_version: VERSION,
      environment: configuration.environment,
      release: configuration.release,
      ...browserContext(),
      ...(options.context ?? {}),
    },
    environment: {
      ...browserEnvironment(),
      ...(options.environment ?? {}),
    },
    session: options.session ?? {},
    params: filterParams(options.params ?? {}, configuration.filterKeys),
  };
}

function browserContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof document !== "undefined" && document.URL) {
    out.url = document.URL;
  }
  if (typeof location !== "undefined") {
    out.action = location.pathname;
  }
  return out;
}

function browserEnvironment(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof navigator !== "undefined") {
    if (navigator.userAgent) out.user_agent = navigator.userAgent;
    if (navigator.language) out.language = navigator.language;
  }
  if (typeof location !== "undefined") {
    out.path = location.pathname;
    out.referrer = typeof document !== "undefined" ? document.referrer : undefined;
  }
  if (typeof screen !== "undefined") {
    out.screen = `${screen.width}x${screen.height}`;
  }
  return out;
}

function errorType(error: Error): string {
  if (typeof error.name === "string" && error.name.length > 0) {
    return error.name;
  }
  return error.constructor?.name ?? "Error";
}
