import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs", "iife"],
  globalName: "MakerchipView",
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  outExtension({ format }) {
    if (format === "esm") return { js: ".js" };
    if (format === "cjs") return { js: ".cjs" };
    return { js: ".global.js" };
  },
});
