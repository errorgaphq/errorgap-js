import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { Errorgap } from "../src/index.js";
import { ErrorgapBoundary } from "../src/react.js";

interface CapturedRequest {
  body: Record<string, unknown>;
}

function installFakeFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = init?.body;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captured.push({ body: body as Record<string, unknown> });
    return new Response('{"group_id":"g_1"}', {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return captured;
}

function Boom(): never {
  throw new Error("react-boom");
}

describe("ErrorgapBoundary", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
    Errorgap.init({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: false,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("catches render errors, reports them, and renders fallback", async () => {
    // React logs to console.error on caught errors; silence to keep output clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { container } = render(
      <ErrorgapBoundary fallback={<div data-testid="fallback">oops</div>}>
        <Boom />
      </ErrorgapBoundary>,
    );

    await Errorgap.flush();
    expect(container.querySelector('[data-testid="fallback"]')?.textContent).toBe("oops");

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const firstError = (body.errors as Array<{ message: string }>)[0]!;
    expect(firstError.message).toBe("react-boom");
    expect((body.context as Record<string, unknown>).source).toBe("react.ErrorgapBoundary");

    errSpy.mockRestore();
  });

  it("shares the configured client across independently loaded entry points", async () => {
    // Published builds bundle index and react separately. Resetting the module
    // graph reproduces that duplication and protects the shared runtime state.
    vi.resetModules();
    const { ErrorgapBoundary: IndependentlyLoadedBoundary } = await import(
      "../src/react.js"
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <IndependentlyLoadedBoundary fallback={<div>fallback</div>}>
        <Boom />
      </IndependentlyLoadedBoundary>,
    );

    await Errorgap.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      context: { source: "react.ErrorgapBoundary" },
      errors: [{ message: "react-boom" }],
    });

    errSpy.mockRestore();
  });
});
