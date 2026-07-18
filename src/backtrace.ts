export interface BacktraceFrame {
  file?: string;
  line?: number;
  column?: number;
  function?: string;
  in_app?: boolean;
  index: number;
  source?: SourceExcerpt;
}

export interface SourceExcerpt {
  start_line: number;
  lines: string[];
}

const V8_AT = /^\s*at\s+(?:(.*?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/;
const SAFARI_AT = /^(?:(.*?)@)?(.+?)(?::(\d+))?(?::(\d+))?$/;

export function parseBacktrace(error: Error): BacktraceFrame[] {
  const stack = typeof error.stack === "string" ? error.stack : "";
  if (!stack) return [];

  const origin = typeof location !== "undefined" ? location.origin : "";
  const lines = stack.split("\n");
  const frames: BacktraceFrame[] = [];
  let index = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Error") || trimmed.endsWith(":")) continue;

    const match = parseLine(trimmed);
    if (!match) continue;

    const [fnName, location, lineNumber, columnNumber] = match;
    frames.push({
      file: stripOrigin(location, origin),
      line: lineNumber,
      column: columnNumber,
      function: fnName,
      in_app: isInApp(location, origin),
      index: index++,
    });
  }

  return frames;
}

function parseLine(
  line: string,
): [string | undefined, string, number | undefined, number | undefined] | null {
  if (line.startsWith("at ")) {
    const m = line.match(V8_AT);
    if (!m) return null;
    return [
      m[1] || undefined,
      m[2] ?? "",
      m[3] ? Number(m[3]) : undefined,
      m[4] ? Number(m[4]) : undefined,
    ];
  }
  // Firefox / Safari: function@url:line:col, or just url:line:col
  const m = line.match(SAFARI_AT);
  if (!m) return null;
  return [
    m[1] || undefined,
    m[2] ?? "",
    m[3] ? Number(m[3]) : undefined,
    m[4] ? Number(m[4]) : undefined,
  ];
}

function stripOrigin(file: string, origin: string): string {
  if (!origin) return file;
  if (file.startsWith(origin)) {
    const stripped = file.slice(origin.length);
    return stripped.startsWith("/") ? stripped.slice(1) : stripped;
  }
  return file;
}

function isInApp(file: string, origin: string): boolean {
  if (!file) return false;
  if (file.includes("node_modules")) return false;
  if (!origin) return true;
  return file.startsWith(origin);
}
