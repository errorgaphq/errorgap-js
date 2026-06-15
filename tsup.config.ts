import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/react.tsx"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2020",
    splitting: false,
    treeshake: true,
    platform: "browser",
    external: ["react"],
  },
  {
    entry: { index: "src/index.ts" },
    format: ["iife"],
    globalName: "Errorgap",
    sourcemap: true,
    target: "es2020",
    platform: "browser",
    minify: true,
    outExtension: () => ({ js: ".global.js" }),
  },
]);
