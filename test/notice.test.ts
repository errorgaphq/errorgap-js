import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";
import { buildNotice } from "../src/notice.js";
import { VERSION } from "../src/version.js";

describe("buildNotice", () => {
  const config = new Configuration({
    endpoint: "https://e.example.com",
    projectSlug: "demo",
    projectId: "p_1",
    environment: "test",
    release: "1.2.3",
  });

  it("captures type and message from an Error", () => {
    const err = new TypeError("boom");
    const notice = buildNotice(err, config);
    expect(notice.errors[0]?.type).toBe("TypeError");
    expect(notice.errors[0]?.message).toBe("boom");
  });

  it("includes notifier identification and release in context", () => {
    const notice = buildNotice(new Error("x"), config);
    expect(notice.context.notifier).toBe("errorgap-browser");
    expect(notice.context.notifier_version).toBe(VERSION);
    expect(notice.context.environment).toBe("test");
    expect(notice.context.release).toBe("1.2.3");
  });

  it("includes browser user_agent in environment", () => {
    const notice = buildNotice(new Error("x"), config);
    expect(notice.environment.user_agent).toBeTruthy();
  });

  it("filters sensitive params", () => {
    const notice = buildNotice(new Error("x"), config, {
      params: {
        username: "alice",
        password: "hunter2",
        nested: { auth_token: "abc", safe: "ok" },
      },
    });
    expect(notice.params.username).toBe("alice");
    expect(notice.params.password).toBe("[FILTERED]");
    expect((notice.params.nested as Record<string, unknown>).auth_token).toBe("[FILTERED]");
  });

  it("merges custom context over defaults", () => {
    const notice = buildNotice(new Error("x"), config, {
      context: { component: "checkout" },
    });
    expect(notice.context.component).toBe("checkout");
    expect(notice.context.notifier).toBe("errorgap-browser");
  });
});
