import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: [
    "@model-regression-sentinel/spec",
    "@model-regression-sentinel/run",
    "@model-regression-sentinel/baseline",
    "@model-regression-sentinel/detect",
  ],
});
