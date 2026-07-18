import { describe, it, expect } from "vitest";
import { parseBacktrace } from "../src/backtrace.js";

describe("parseBacktrace", () => {
  it("returns an empty array when there is no stack", () => {
    const err = new Error("x");
    err.stack = undefined as unknown as string;
    expect(parseBacktrace(err)).toEqual([]);
  });

  it("parses V8-style frames (Chrome)", () => {
    const err = new Error("x");
    err.stack = [
      "Error: x",
      "    at handler (https://app.example.com/static/handler.js:42:10)",
      "    at https://app.example.com/static/index.js:9:5",
    ].join("\n");

    const frames = parseBacktrace(err);
    expect(frames.length).toBe(2);
    expect(frames[0]?.function).toBe("handler");
    expect(frames[0]?.line).toBe(42);
    expect(frames[0]?.column).toBe(10);
    expect(frames[1]?.function).toBeUndefined();
  });

  it("parses Safari/Firefox-style frames", () => {
    const err = new Error("x");
    err.stack = [
      "handler@https://app.example.com/static/handler.js:42:10",
      "@https://app.example.com/static/index.js:9:5",
    ].join("\n");

    const frames = parseBacktrace(err);
    expect(frames.length).toBe(2);
    expect(frames[0]?.function).toBe("handler");
    expect(frames[0]?.line).toBe(42);
    expect(frames[0]?.column).toBe(10);
  });

  it("strips happy-dom origin from frames when present", () => {
    const err = new Error("x");
    const origin = typeof location !== "undefined" ? location.origin : "";
    err.stack = `at run (${origin}/main.js:1:1)`;
    const frames = parseBacktrace(err);
    if (origin) {
      expect(frames[0]?.file).toBe("main.js");
    }
  });
});
