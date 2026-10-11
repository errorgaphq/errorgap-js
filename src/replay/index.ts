import type { Configuration } from "../configuration.js";
import { ReplayRecorder, type ReplayOptions } from "./recorder.js";

export type { ReplayOptions } from "./recorder.js";

const RECORDER_KEY = Symbol.for("@errorgap/browser/replay");

type ReplayGlobal = typeof globalThis & { [RECORDER_KEY]?: ReplayRecorder };

/** Start session replay; replaces a recorder started by an earlier `init`. */
export function startReplay(configuration: Configuration, options: ReplayOptions = {}): void {
  stopReplay();
  if (typeof window === "undefined" || typeof document === "undefined" || typeof location === "undefined") {
    return;
  }
  const recorder = new ReplayRecorder(configuration, options);
  (globalThis as ReplayGlobal)[RECORDER_KEY] = recorder;
  recorder.start();
}

export function stopReplay(): void {
  const root = globalThis as ReplayGlobal;
  root[RECORDER_KEY]?.stop();
  delete root[RECORDER_KEY];
}

/**
 * Called by the client as it reports an error. Returns the function to call
 * with the error group's id once the server has answered.
 */
export function replayErrorStarted(label: string): (groupId?: string) => void {
  const recorder = (globalThis as ReplayGlobal)[RECORDER_KEY];
  if (!recorder) return () => undefined;
  try {
    return recorder.errorStarted(label);
  } catch {
    return () => undefined;
  }
}

/** Take a DOM snapshot now, when this session is recorded and the project captures them. */
export function captureReplaySnapshot(): boolean {
  const recorder = (globalThis as ReplayGlobal)[RECORDER_KEY];
  try {
    return recorder?.captureSnapshot() ?? false;
  } catch {
    return false;
  }
}
