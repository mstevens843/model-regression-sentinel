#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/cli.js");

if (!existsSync(cli)) {
  process.stderr.write(
    "sentinel has not been built yet. Run `pnpm build` from the repository root, then try again.\n",
  );
  process.exitCode = 2;
} else {
  await import(pathToFileURL(cli).href);
}
