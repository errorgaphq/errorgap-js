import type { NoticePayload } from "./notice.js";

const EXTENSION_URL = /^(chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;
const SCRIPT_ERROR = /^Script error\.?$/i;
const RESIZE_OBSERVER = /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

/**
 * Errors the page's owner can do nothing about:
 * - `Script error.` with no stack: the browser hides the details of an error
 *   in a cross-origin script that was loaded without CORS.
 * - errors thrown from a browser extension's own code.
 * - `ResizeObserver loop …`: a benign browser notice, not a failure.
 */
export function isNoise(notice: NoticePayload): boolean {
  const error = notice.errors[0];
  if (!error) return false;
  if (SCRIPT_ERROR.test(error.message) && error.backtrace.length === 0) return true;
  if (RESIZE_OBSERVER.test(error.message)) return true;
  const top = error.backtrace[0];
  return typeof top?.file === "string" && EXTENSION_URL.test(top.file);
}

/**
 * Lets an identical error (same type, message and top frame) through at
 * most once per window, so one thrown in a loop cannot flood the project.
 */
export class Deduper {
  private lastSent = new Map<string, number>();

  duplicate(notice: NoticePayload, windowMs: number, now = Date.now()): boolean {
    if (windowMs <= 0) return false;
    const error = notice.errors[0];
    if (!error) return false;
    const top = error.backtrace[0];
    const key = `${error.type}\\n${error.message}\\n${top?.file ?? ""}:${top?.line ?? ""}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < windowMs) return true;

    if (this.lastSent.size >= 100) this.lastSent.clear();
    this.lastSent.set(key, now);
    return false;
  }
}
