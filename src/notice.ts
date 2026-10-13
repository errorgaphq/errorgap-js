import type { Configuration } from "./configuration.js";
import { parseBacktrace, type BacktraceFrame } from "./backtrace.js";
import { cleanRecord, filterParams, truncateString } from "./filter.js";
import { VERSION } from "./version.js";

/** Who was using the page; sent as `session.user_id` / `session.user_email`. */
export interface NoticeUser {
  id?: string | number;
  email?: string;
}

const MAX_CAUSE_DEPTH = 10;
const MAX_MESSAGE_LENGTH = 8192;

export interface NoticeContext {
  user?: NoticeUser | null;
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
  const chain = errorChain(error);
  const causes = chain.slice(1).map((link) => ({ type: errorType(link), message: message(link) }));

  // Each cause's frames follow the error's own, re-indexed, so the
  // dashboard renders the whole chain as one backtrace.
  const backtrace: BacktraceFrame[] = [];
  for (const link of chain) {
    for (const frame of parseBacktrace(link)) {
      backtrace.push({ ...frame, index: backtrace.length });
    }
  }

  return {
    project_id: configuration.projectId,
    received_at: new Date().toISOString(),
    errors: [{ type: errorType(error), message: message(error), backtrace }],
    context: {
      notifier: "errorgap-browser",
      notifier_version: VERSION,
      environment: configuration.environment,
      release: configuration.release,
      ...browserContext(),
      ...(causes.length > 0 ? { causes } : {}),
      ...cleanRecord(options.context),
    },
    environment: {
      ...browserEnvironment(),
      ...cleanRecord(options.environment),
    },
    session: filterParams(
      { ...userSession(options.user), ...(options.session ?? {}) },
      configuration.filterKeys,
    ),
    params: filterParams(options.params ?? {}, configuration.filterKeys),
  };
}

function userSession(user: NoticeUser | null | undefined): Record<string, unknown> {
  const session: Record<string, unknown> = {};
  if (user?.id !== undefined && user.id !== null && String(user.id) !== "") session.user_id = String(user.id);
  if (user?.email) session.user_email = String(user.email);
  return session;
}

/** The error, then its `cause`, then that one's, without looping. */
function errorChain(error: Error): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain.length > 0 ? chain : [error];
}

function message(error: Error): string {
  return truncateString(String(error.message ?? ""), MAX_MESSAGE_LENGTH);
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
