import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches the published package version", () => {
    expect(VERSION).toBe(packageMetadata.version);
  });
});
