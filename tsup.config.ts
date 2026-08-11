import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    login: "src/login.ts",
    "ai-sdk": "src/ai-sdk.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  // Entry isolation is a contract, not an optimization: `subauth` must not pull
  // in node:http / node:child_process just because ./login needs them. Shared
  // chunks would defeat that, so each entry is emitted standalone.
  splitting: false,
  treeshake: true,
  sourcemap: false,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".js" : ".mjs" };
  },
});
