export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface ConfigurationInput {
  endpoint?: string;
  projectSlug?: string;
  projectId?: string;
  apiKey?: string;
  environment?: string;
  release?: string;
  async?: boolean;
  logger?: Logger | null;
  filterKeys?: string[];
  sampleRate?: number;
  /**
   * When set, fetched URLs matching this prefix are NOT instrumented
   * for outbound logging. Use it to point the SDK at your own ingest
   * URL without triggering recursive notices.
   */
  ignoreOrigins?: string[];
}

const DEFAULT_FILTER_KEYS = [
  "password",
  "password_confirmation",
  "token",
  "secret",
  "api_key",
  "authorization",
  "cookie",
];

export class Configuration {
  endpoint: string;
  projectSlug: string | undefined;
  projectId: string | undefined;
  apiKey: string | undefined;
  environment: string;
  release: string | undefined;
  async: boolean;
  logger: Logger | null;
  filterKeys: string[];
  sampleRate: number;
  ignoreOrigins: string[];

  constructor(input: ConfigurationInput = {}) {
    this.endpoint = input.endpoint ?? "";
    this.projectSlug = input.projectSlug;
    this.projectId = input.projectId;
    this.apiKey = input.apiKey;
    this.environment = input.environment ?? "production";
    this.release = input.release;
    this.async = input.async ?? true;
    this.logger = input.logger === undefined ? safeConsole() : input.logger;
    this.filterKeys = input.filterKeys ?? [...DEFAULT_FILTER_KEYS];
    this.sampleRate = clampRate(input.sampleRate);
    this.ignoreOrigins = input.ignoreOrigins ?? [];
  }

  validate(): void {
    if (!this.endpoint || this.endpoint.trim().length === 0) {
      throw new Error("Errorgap endpoint is required");
    }
    if (!this.projectSlug || this.projectSlug.trim().length === 0) {
      throw new Error("Errorgap projectSlug is required");
    }
  }
}

function safeConsole(): Logger | null {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    return console;
  }
  return null;
}

function clampRate(rate: number | undefined): number {
  if (rate === undefined || Number.isNaN(rate)) return 1.0;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}
