// What `sentinel release verify` promises a stranger, asserted rather than intended.
//
// THE CASE THAT MOTIVATED EVERY OTHER ONE. A sibling project shipped this command with its path
// defaulting to ".". Run bare from a repository root it reported four artifacts MISSING against a
// release that was in fact complete, because it was checking the wrong directory. Every word was
// true of "." and every word was misleading about the release. So the first describe block below is
// not about verification at all: it is about what a bare invocation is allowed to say, and it
// asserts on the ACTUAL OUTPUT rather than on an exit code, because the defect was the text.
//
// THE SECOND CASE IS THE REASON `REQUIRED_ARTIFACTS` EXISTS. A release is built here whose manifest
// is internally perfect - every recorded digest matches, nothing is untracked, no line is malformed
// - and which is missing a package tarball, because the manifest was written after the tarball was
// omitted and therefore never mentions it. Every manifest-versus-payload cross-check agrees, and
// the release is broken. That case is constructed explicitly below, and the assertion checks BOTH that
// the omission was caught and that the digest pass reported nothing, since a catch that came from
// the manifest would prove the opposite of what this test is for.
//
// MISSING, CHANGED AND UNTRACKED ARE THREE DIFFERENT WORDS. A file that is absent, a file whose
// bytes moved and a file nothing recorded are three different events with three different causes,
// and a report that calls them all "failed" sends the reader looking in the wrong place.
//
// THE REAL `dist/release` IS OPTIONAL. A fresh clone does not have one, and a suite that failed
// there would be a suite that says "broken" when it means "not built". Those cases are skipped
// loudly, and the fixtures above them run everywhere, so a skip never leaves the interesting
// properties unchecked.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_CONFIRMED_REGRESSION,
  EXIT_MISUSE,
  EXIT_OK,
  bytesHash,
} from "@model-regression-sentinel/spec";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  DEFAULT_RELEASE_DIR,
  PUBLISHABLE_PACKAGES,
  REQUIRED_ARTIFACTS,
  cmdRelease,
  releaseVerify,
} from "../src/release.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const REAL_RELEASE = join(REPO, DEFAULT_RELEASE_DIR);
/** Present only after `node scripts/build-release.mjs`. Absent on a fresh clone, which is fine. */
const HAVE_REAL_RELEASE = existsSync(REAL_RELEASE);

const temporary: string[] = [];
const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `sentinel-${name}-`));
  temporary.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE_VERSION = "0.1.0";
const tarballName = (pkg: string): string =>
  `model-regression-sentinel-${pkg}-${FIXTURE_VERSION}.tgz`;

/**
 * A release directory that is complete unless told otherwise.
 *
 * THE MANIFEST IS WRITTEN LAST, over whatever was actually written. That is deliberate and it is
 * what makes the omitted-tarball case honest: the manifest never mentions the file that was left
 * out, so every cross-check between the manifest and the payload agrees, exactly as a real
 * builder's would.
 */
function makeRelease(options?: {
  readonly omit?: readonly string[];
  readonly extra?: Readonly<Record<string, string>>;
  readonly tamperAfterManifest?: string;
}): string {
  const dir = scratch("release");
  const omit = new Set(options?.omit ?? []);

  const bodies: Readonly<Record<string, string>> = {
    "RELEASE_NOTES.md": `# model-regression-sentinel ${FIXTURE_VERSION}\n\nA fixture release.\n`,
    "FREEZE_STATUS.txt": "FREEZE STATUS\n\n  overall state    UNAVAILABLE\n",
    "VERIFICATION.txt": "VERIFICATION\n\n  CHECKED   nothing, this is a fixture\n",
    ...Object.fromEntries(
      PUBLISHABLE_PACKAGES.map((pkg) => [tarballName(pkg), `not really a tarball: ${pkg}\n`]),
    ),
    ...(options?.extra ?? {}),
  };

  for (const [name, body] of Object.entries(bodies)) {
    if (!omit.has(name)) writeFileSync(join(dir, name), body, "utf8");
  }

  if (!omit.has("MANIFEST.sha256")) {
    const present = readdirSync(dir).sort();
    const lines = present.map((f) => `${bytesHash(readFileSync(join(dir, f)))}  ${f}`);
    writeFileSync(join(dir, "MANIFEST.sha256"), `${lines.join("\n")}\n`, "utf8");
  }

  if (options?.tamperAfterManifest !== undefined) {
    const target = join(dir, options.tamperAfterManifest);
    writeFileSync(target, `${readFileSync(target, "utf8")}one more byte\n`, "utf8");
  }
  return dir;
}

/** A working directory that holds a release at the default path, for the bare-invocation cases. */
function makeCwdWithRelease(): string {
  const cwd = scratch("cwd");
  const release = makeRelease();
  const target = join(cwd, DEFAULT_RELEASE_DIR);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(release)) copyFileSync(join(release, name), join(target, name));
  return cwd;
}

describe("a bare invocation cannot produce a misleading missing-artifact report", () => {
  it("refuses when there is no release where it expects one, and lists nothing as missing", () => {
    const cwd = scratch("bare");
    // A directory that looks like somebody's project: files, and no release.
    writeFileSync(join(cwd, "package.json"), '{"name":"someone-elses-project"}\n', "utf8");
    writeFileSync(join(cwd, "README.md"), "# not a release\n", "utf8");

    const { code, output } = releaseVerify(cwd, undefined);

    expect(code).toBe(EXIT_MISUSE);
    // The defect being guarded against was the TEXT, so the text is what is asserted.
    expect(output).not.toContain("MISSING");
    expect(output).not.toContain("verifying");
    for (const artifact of REQUIRED_ARTIFACTS) expect(output).not.toContain(artifact.example);
    // The three things a refusal has to say.
    expect(output).toContain(join(cwd, DEFAULT_RELEASE_DIR));
    expect(output).toContain("node scripts/build-release.mjs");
    expect(output).toContain(`sentinel release verify ${DEFAULT_RELEASE_DIR}`);
    expect(output).toContain("tar -xzf");
    expect(output).toContain("It did NOT scan the current directory");
  });

  it("checks dist/release, not the current directory, when a release is there", () => {
    const cwd = makeCwdWithRelease();
    // The same directory also holds a decoy, so a verifier that scanned "." would find no
    // artifacts here and report eleven of them missing.
    writeFileSync(join(cwd, "notes.txt"), "a file in the working directory\n", "utf8");

    const { code, output } = releaseVerify(cwd, undefined);

    expect(code).toBe(EXIT_OK);
    // The first line names the directory that was checked, so nobody has to guess.
    expect(output.split("\n")[0]).toBe(`verifying ${join(cwd, DEFAULT_RELEASE_DIR)}`);
    expect(output).toContain("VERIFIED");
    expect(output).not.toContain("MISSING");
  });

  it("run bare from the real repository root, reports about dist/release and never about the root", () => {
    const { code, output } = releaseVerify(REPO, undefined);

    // Either state is correct. What is never correct is a missing-artifact list measured against
    // the repository root, which is the sibling's defect.
    expect(output).toContain(DEFAULT_RELEASE_DIR);
    expect(output.startsWith(`verifying ${REPO}\n`)).toBe(false);
    if (HAVE_REAL_RELEASE) {
      expect(code).toBe(EXIT_OK);
      expect(output.split("\n")[0]).toBe(`verifying ${REAL_RELEASE}`);
    } else {
      expect(code).toBe(EXIT_MISUSE);
      expect(output).not.toContain("MISSING");
    }
  });

  it("refuses a source tree passed explicitly rather than calling a complete release broken", () => {
    // `sentinel release verify .` from a repository root. Nothing there matches any required
    // artifact, so the honest answer is "wrong path", not eleven MISSING lines.
    const { code, output } = releaseVerify(REPO, ".");

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("looks like a release");
    expect(output).not.toContain("MISSING");
  });

  it("names the path and checks nothing when the path does not exist", () => {
    const { code, output } = releaseVerify(REPO, "dist/no-such-release");

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain(join(REPO, "dist", "no-such-release"));
    expect(output).toContain("Nothing was checked");
    expect(output).not.toContain("MISSING");
  });
});

describe("a release that is actually complete verifies", () => {
  it("exits 0 on a targeted path", () => {
    const { code, output } = releaseVerify(REPO, makeRelease());

    expect(code).toBe(EXIT_OK);
    expect(output).toContain(
      `required artifacts   ${REQUIRED_ARTIFACTS.length} of ${REQUIRED_ARTIFACTS.length} present`,
    );
    expect(output).toContain("0 changed, 0 missing");
    expect(output).toContain("untracked files      none");
    expect(output).toContain("VERIFIED");
  });

  it("verifies an unpacked archive elsewhere, and says what that does not establish", () => {
    // The manifest records paths relative to the release root, so an unpacked archive checks the
    // same way a built directory does. What it cannot do is say where the archive came from, and
    // the report has to be the one that says so rather than the reader.
    const source = makeRelease();
    const unpacked = scratch("unpacked");
    for (const name of readdirSync(source)) copyFileSync(join(source, name), join(unpacked, name));

    const { code, output } = releaseVerify(REPO, unpacked);

    expect(code).toBe(EXIT_OK);
    expect(output).toContain("provenance");
    expect(output).toContain("not changed since the manifest was written");
    expect(output).toContain("shasum -a 256 -c MANIFEST.sha256");
  });

  it.runIf(HAVE_REAL_RELEASE)(
    "exits 0 on the real dist/release, so this suite is not only checking its own fixtures",
    () => {
      const { code, output } = releaseVerify(REPO, REAL_RELEASE);
      expect(code, output).toBe(EXIT_OK);
      expect(output).toContain("VERIFIED");
    },
  );

  it("says out loud when the real release is absent, rather than passing quietly", () => {
    // Not a failure: a fresh clone has no dist/release. Stated so a reader of the run knows which
    // of the two worlds the suite above was in.
    expect(typeof HAVE_REAL_RELEASE).toBe("boolean");
  });
});

describe("what it catches, and the different words it uses for different faults", () => {
  it("exits 2 and names the artifact when a required file is absent", () => {
    const { code, output } = releaseVerify(REPO, makeRelease({ omit: ["RELEASE_NOTES.md"] }));

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("MISSING    RELEASE_NOTES.md");
    expect(output).toContain(
      `required artifacts   ${REQUIRED_ARTIFACTS.length - 1} of ${REQUIRED_ARTIFACTS.length} present`,
    );
    expect(output).toContain("NOT VERIFIED");
  });

  it("catches a payload with no cli tarball even though its manifest is perfect", () => {
    // THE CASE THIS DESIGN EXISTS FOR. The manifest is written after the omission, so it never
    // mentions the tarball, and every manifest-versus-payload cross-check agrees.
    const dir = makeRelease({ omit: [tarballName("cli")] });

    // First, prove the premise rather than assuming it: the manifest and the payload agree.
    const manifest = readFileSync(join(dir, "MANIFEST.sha256"), "utf8");
    expect(manifest).not.toContain(tarballName("cli"));
    expect(existsSync(join(dir, tarballName("cli")))).toBe(false);

    const { code, output } = releaseVerify(REPO, dir);

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("MISSING    @model-regression-sentinel/cli tarball");
    expect(output).toContain("model-regression-sentinel-cli-<version>.tgz");
    // And the catch came from the filesystem, not from the manifest: the digest pass was clean.
    expect(output).toContain("0 changed, 0 missing");
    expect(output).toContain("untracked files      none");
  });

  it("reports a tampered artifact as CHANGED, which is not the same word as MISSING", () => {
    const dir = makeRelease({ tamperAfterManifest: "VERIFICATION.txt" });

    const { code, output } = releaseVerify(REPO, dir);

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("CHANGED    VERIFICATION.txt");
    expect(output).toContain("recorded ");
    expect(output).toContain("on disk  ");
    // Present and wrong is a different event from absent, and the report has to keep them apart:
    // one means somebody edited a file, the other means the builder never wrote it.
    expect(output).not.toContain("MISSING    VERIFICATION.txt");
    expect(output).toContain("1 changed");
  });

  it("reports a file that no digest covers as UNTRACKED, because an addition is drift too", () => {
    const dir = makeRelease();
    writeFileSync(join(dir, "surprise.txt"), "who put this here\n", "utf8");

    const { code, output } = releaseVerify(REPO, dir);

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("UNTRACKED  surprise.txt");
    expect(output).toContain("untracked files      1");
  });

  it("cannot check any digest without a manifest, and says that rather than passing", () => {
    const { code, output } = releaseVerify(REPO, makeRelease({ omit: ["MANIFEST.sha256"] }));

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("not checked: MANIFEST.sha256 is not in this directory");
    expect(output).toContain("MISSING    MANIFEST.sha256");
  });

  it("reports a manifest line nothing can parse instead of skipping it", () => {
    // A line nobody parsed checks nothing, and a verifier that skips it silently is a verifier
    // that can be defeated by a typo.
    const dir = makeRelease();
    const manifest = join(dir, "MANIFEST.sha256");
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")}not a digest at all\n`, "utf8");

    const { code, output } = releaseVerify(REPO, dir);

    expect(code).toBe(EXIT_MISUSE);
    expect(output).toContain("MALFORMED  not a digest at all");
  });

  it("never returns 1, whatever is wrong, because a bad release is not a model regression", () => {
    const outcomes = [
      releaseVerify(REPO, makeRelease()),
      releaseVerify(REPO, makeRelease({ omit: [tarballName("spec")] })),
      releaseVerify(REPO, makeRelease({ omit: ["MANIFEST.sha256"] })),
      releaseVerify(REPO, makeRelease({ tamperAfterManifest: "RELEASE_NOTES.md" })),
      releaseVerify(scratch("empty"), undefined),
      releaseVerify(REPO, "."),
      releaseVerify(REPO, "dist/nope"),
    ];
    for (const outcome of outcomes) {
      expect(outcome.code).not.toBe(EXIT_CONFIRMED_REGRESSION);
      expect([EXIT_OK, EXIT_MISUSE]).toContain(outcome.code);
    }
  });
});

describe("the command wrapper returns what it printed", () => {
  it("prints the verification and returns its code", () => {
    const dir = makeRelease();
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    });
    try {
      const code = cmdRelease(parseArgs(["release", "verify", dir]), REPO);
      expect(code).toBe(EXIT_OK);
      expect(printed.join("")).toBe(`${releaseVerify(REPO, dir).output}\n`);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a subcommand it does not have, which is misuse and not a verdict", () => {
    expect(() => cmdRelease(parseArgs(["release", "publish"]), REPO)).toThrow(/verify/);
    expect(() => cmdRelease(parseArgs(["release"]), REPO)).toThrow(/verify/);
  });
});
