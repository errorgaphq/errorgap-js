import {
  GREATEST_LOWER_BOUND,
  TraceMap,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";
import type { BacktraceFrame, SourceExcerpt } from "./backtrace.js";

export const SOURCE_CONTEXT_RADIUS = 6;
export const MAX_SOURCE_LINE_CHARS = 400;
export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GENERATED_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 5 * 1024 * 1024;
const SOURCE_MAP_FETCH_TIMEOUT_MS = 2_000;

const maps = new Map<string, Promise<TraceMap | null>>();

export async function enrichBacktrace(
  backtrace: BacktraceFrame[],
): Promise<BacktraceFrame[]> {
  return Promise.all(backtrace.map((frame) => enrichFrame(frame)));
}

async function enrichFrame(frame: BacktraceFrame): Promise<BacktraceFrame> {
  if (!frame.in_app) return frame;
  const generatedUrl = generatedFileUrl(frame.file);
  if (!generatedUrl || !frame.line || frame.line < 1) return frame;

  try {
    const map = await sourceMapFor(generatedUrl);
    if (!map) return frame;

    const original = originalPositionFor(map, {
      line: frame.line,
      column: Math.max(0, (frame.column ?? 1) - 1),
      bias: GREATEST_LOWER_BOUND,
    });
    if (!original.source || !original.line) return frame;

    const content = sourceContentFor(map, original.source);
    const source = sourceExcerpt(content, original.line);
    const file = normalizeSourcePath(original.source);

    return {
      ...frame,
      file,
      line: original.line,
      column: original.column === null ? undefined : original.column + 1,
      function: original.name ?? frame.function,
      in_app: isOriginalInApp(file),
      ...(source ? { source } : {}),
    };
  } catch {
    // Source maps are an enhancement. Missing, malformed, or CORS-blocked maps
    // must never prevent delivery of the original generated frame.
    return frame;
  }
}

function sourceMapFor(generatedUrl: string): Promise<TraceMap | null> {
  let pending = maps.get(generatedUrl);
  if (!pending) {
    pending = loadSourceMap(generatedUrl);
    maps.set(generatedUrl, pending);
  }
  return pending;
}

async function loadSourceMap(generatedUrl: string): Promise<TraceMap | null> {
  const generated = await fetchText(generatedUrl, MAX_GENERATED_FILE_BYTES);
  if (!generated) return null;

  const reference = lastSourceMapReference(generated);
  if (!reference) return null;

  if (reference.startsWith("data:")) {
    const decoded = decodeInlineSourceMap(reference);
    return decoded ? new TraceMap(decoded, generatedUrl) : null;
  }

  const mapUrl = new URL(reference, generatedUrl).href;
  const encodedMap = await fetchText(mapUrl, MAX_SOURCE_MAP_BYTES);
  if (!encodedMap) return null;
  return new TraceMap(encodedMap, mapUrl);
}

async function fetchText(url: string, maxBytes: number): Promise<string | null> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), SOURCE_MAP_FETCH_TIMEOUT_MS)
    : null;
  try {
    const response = await fetch(url, {
      credentials: "omit",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;

    const text = await response.text();
    return text.length <= maxBytes ? text : null;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function lastSourceMapReference(source: string): string | null {
  const pattern = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=([^\s*]+)[^\n]*?/g;
  let reference: string | null = null;
  for (const match of source.matchAll(pattern)) {
    reference = match[1] ?? null;
  }
  return reference;
}

function decodeInlineSourceMap(reference: string): string | null {
  const comma = reference.indexOf(",");
  if (comma < 0) return null;
  const metadata = reference.slice(0, comma);
  const value = reference.slice(comma + 1);
  try {
    if (metadata.endsWith(";base64")) {
      if (typeof atob !== "function") return null;
      const binary = atob(value);
      if (typeof TextDecoder === "undefined") return binary;
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function generatedFileUrl(file: string | undefined): string | null {
  if (!file || file.startsWith("<") || file === "native") return null;
  try {
    const base =
      typeof document !== "undefined" && document.baseURI
        ? document.baseURI
        : typeof location !== "undefined"
          ? location.href
          : undefined;
    if (!base) return null;
    const url = new URL(file, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeSourcePath(source: string): string {
  try {
    const url = new URL(source);
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return source
      .replace(/^(?:webpack|vite):\/\/+/, "")
      .replace(/^(?:\.\.\/)+/, "")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
  }
}

function isOriginalInApp(file: string): boolean {
  return !file.includes("node_modules/") && !file.startsWith("node:");
}

function sourceExcerpt(content: string | null, line: number): SourceExcerpt | undefined {
  if (!content || content.length > MAX_SOURCE_FILE_BYTES) return undefined;
  const lines = content.split(/\r?\n/);
  if (line < 1 || line > lines.length) return undefined;

  const startLine = Math.max(1, line - SOURCE_CONTEXT_RADIUS);
  const endLine = Math.min(lines.length, line + SOURCE_CONTEXT_RADIUS);
  return {
    start_line: startLine,
    lines: lines
      .slice(startLine - 1, endLine)
      .map((sourceLine) => sourceLine.slice(0, MAX_SOURCE_LINE_CHARS)),
  };
}
