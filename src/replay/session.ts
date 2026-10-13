/**
 * The replay session for this tab: its id, when it started, and whether it is
 * being recorded. Kept in `sessionStorage` so it survives full page loads in
 * the same tab, and replaced after 30 minutes without activity.
 */

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const STORAGE_KEY = "errorgap:replay-session";
/** Events recorded before the session's first error, carried across page loads. */
const BUFFER_KEY = "errorgap:replay-buffer";

/** The recording decision, made once per session from the project's settings. */
export interface RecordingDecision {
  record: boolean;
  captureSnaps: boolean;
  snapTrigger: string;
}

export interface ReplaySession {
  id: string;
  startedAt: number;
  lastActivity: number;
  /** Unset until the project's replay settings have been read. */
  decision?: RecordingDecision;
  hadError: boolean;
}

/** The tab's session, or a new one when there is none or it went idle. */
export function currentSession(now: number = Date.now()): ReplaySession {
  const stored = read();
  if (stored && now - stored.lastActivity < IDLE_TIMEOUT_MS) {
    stored.lastActivity = now;
    save(stored);
    return stored;
  }
  const session: ReplaySession = { id: uuid(), startedAt: now, lastActivity: now, hadError: false };
  save(session);
  clearBuffer();
  return session;
}

/**
 * Hold a session's events until it has an error: only sessions with one are
 * kept, so nothing is sent before then. Kept in `sessionStorage` so the pages
 * before the error are part of the replay.
 */
export function saveBuffer<T>(sessionId: string, events: T[]): void {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify({ id: sessionId, events }));
  } catch {
    // Storage full or blocked: this page's events only.
  }
}

/** The held events for this session, removed from storage. */
export function takeBuffer<T>(sessionId: string): T[] {
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    sessionStorage.removeItem(BUFFER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { id?: unknown; events?: unknown };
    return parsed.id === sessionId && Array.isArray(parsed.events) ? (parsed.events as T[]) : [];
  } catch {
    return [];
  }
}

export function clearBuffer(): void {
  try {
    sessionStorage.removeItem(BUFFER_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function save(session: ReplaySession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage full or blocked: the session lives for this page only.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
  clearBuffer();
}

function read(): ReplaySession | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ReplaySession>;
    if (typeof parsed.id !== "string" || typeof parsed.startedAt !== "number") return undefined;
    return {
      id: parsed.id,
      startedAt: parsed.startedAt,
      lastActivity: typeof parsed.lastActivity === "number" ? parsed.lastActivity : parsed.startedAt,
      decision: parsed.decision,
      hadError: parsed.hadError === true,
    };
  } catch {
    return undefined;
  }
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
