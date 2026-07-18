import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichBacktrace } from "../src/source-maps.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("source-map backtraces", () => {
  it("maps a generated frame and includes the original source excerpt", async () => {
    const map = {
      version: 3,
      file: "app.js",
      sources: ["../src/App.tsx"],
      sourcesContent: ["const ready = true;\nthrow new BrowserFailure();\nrender();"],
      names: [],
      mappings: "AAAA;AACA;AACA",
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("app.js.map")) {
        return new Response(JSON.stringify(map), { status: 200 });
      }
      return new Response("bundle();\n//# sourceMappingURL=app.js.map", { status: 200 });
    }) as typeof fetch;

    const [frame] = await enrichBacktrace([
      { file: "assets/source-map-app.js", line: 2, column: 1, in_app: true, index: 0 },
    ]);

    expect(frame).toMatchObject({
      file: "src/App.tsx",
      line: 2,
      column: 1,
      in_app: true,
      source: {
        start_line: 1,
        lines: ["const ready = true;", "throw new BrowserFailure();", "render();"],
      },
    });
  });

  it("classifies mapped dependency frames as vendor code", async () => {
    const map = {
      version: 3,
      sources: ["../node_modules/react/index.js"],
      sourcesContent: ["export function render() {}"],
      names: [],
      mappings: "AAAA",
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("vendor.js.map")) {
        return new Response(JSON.stringify(map), { status: 200 });
      }
      return new Response("vendor();\n//# sourceMappingURL=vendor.js.map", { status: 200 });
    }) as typeof fetch;

    const [frame] = await enrichBacktrace([
      { file: "assets/vendor.js", line: 1, column: 1, in_app: true, index: 0 },
    ]);

    expect(frame).toMatchObject({
      file: "node_modules/react/index.js",
      line: 1,
      in_app: false,
      source: { start_line: 1, lines: ["export function render() {}"] },
    });
  });

  it("preserves the generated frame when a source map is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bundle();", { status: 200 })) as typeof fetch;
    const input = { file: "assets/no-map.js", line: 4, column: 2, in_app: true, index: 0 };

    await expect(enrichBacktrace([input])).resolves.toEqual([input]);
  });
});
