import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";

describe("Configuration", () => {
  it("uses defaults when nothing is provided", () => {
    const config = new Configuration();
    expect(config.environment).toBe("production");
    expect(config.async).toBe(true);
    expect(config.filterKeys).toContain("password");
    expect(config.sampleRate).toBe(1);
    expect(config.sourceMaps).toBe(true);
  });

  it("allows source-map resolution to be disabled", () => {
    expect(new Configuration({ sourceMaps: false }).sourceMaps).toBe(false);
  });

  it("clamps sample rate to [0, 1]", () => {
    expect(new Configuration({ sampleRate: -1 }).sampleRate).toBe(0);
    expect(new Configuration({ sampleRate: 2 }).sampleRate).toBe(1);
    expect(new Configuration({ sampleRate: 0.5 }).sampleRate).toBe(0.5);
  });

  it("validate throws when endpoint missing", () => {
    const config = new Configuration({ projectSlug: "demo" });
    expect(() => config.validate()).toThrow(/endpoint/);
  });

  it("validate throws when projectSlug missing", () => {
    const config = new Configuration({ endpoint: "https://e.example.com" });
    expect(() => config.validate()).toThrow(/projectSlug/);
  });

  it("validate passes when both endpoint and projectSlug present", () => {
    const config = new Configuration({
      endpoint: "https://e.example.com",
      projectSlug: "demo",
    });
    expect(() => config.validate()).not.toThrow();
  });
});
