import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Errorgap } from "../src/index.js";

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

describe("global handlers", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
    Errorgap.init({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Errorgap.init({ captureGlobals: false });
  });

  it("notifies on window 'error' events", async () => {
    const errorEvent = new ErrorEvent("error", {
      error: new Error("from-window"),
      message: "from-window",
    });
    window.dispatchEvent(errorEvent);
    await Errorgap.flush();

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const firstError = (body.errors as Array<{ message: string }>)[0]!;
    expect(firstError.message).toBe("from-window");
    expect((body.context as Record<string, unknown>).source).toBe("window.onerror");
  });

  it("notifies on 'unhandledrejection' events", async () => {
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    (event as unknown as { reason: unknown }).reason = new Error("rejected");
    window.dispatchEvent(event);
    await Errorgap.flush();

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const firstError = (body.errors as Array<{ message: string }>)[0]!;
    expect(firstError.message).toBe("rejected");
    expect((body.context as Record<string, unknown>).source).toBe("unhandledrejection");
  });
});
