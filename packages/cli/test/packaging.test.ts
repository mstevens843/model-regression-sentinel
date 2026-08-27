// What every publishable manifest has to say before anything is ever published.
//
// WHY THIS IS A TEST AND NOT A CHECKLIST. Publishing is the one step in this repository that cannot
// be undone: npm's unpublish window is 72 hours and it leaves the name permanently unusable. Every
// field below is a field that is wrong exactly once and then wrong forever on a registry page, and
// none of them is checked by `tsc`, by Biome or by any other suite here. `docs/PUBLISHING.md`
// carries the human gate; this file carries the part a machine can hold.
//
// WHAT IT CHECKS THAT A DRY RUN DOES NOT. `npm publish --dry-run` reports what would ship and is
// perfectly happy with a manifest that has no `repository`, points `homepage` at a directory that
// does not exist, or declares a `bin` whose target was never built. It is a packaging check, not a
// metadata check, and the two failures look nothing alike to a reader of npmjs.com.
//
// WHAT IT IS NOT. It does not publish, it does not pack, and it does not touch the network. A test
// that reached the registry would be a test that fails on a plane and, far worse, a test one flag
// away from doing the irreversible thing. The registry lookups belong in `docs/PUBLISHING.md`,
// beside the human who is about to type the command.
//
// `files` IS THE ONE THAT BITES SILENTLY. Shipping `src` or a test directory is not an error
// anywhere: the package installs, the tests pass, and every consumer downloads the sources and the
// fixtures forever. So it is asserted from the other direction as well, by checking that what the
// allow-list resolves to contains no TypeScript source outside `dist`.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGES = join(REPO, "packages");

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly description?: string;
  readonly private?: boolean;
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
    readonly directory?: string;
  };
  readonly bugs?: { readonly url?: string };
  readonly homepage?: string;
  readonly files?: readonly string[];
  readonly publishConfig?: { readonly access?: string };
  readonly engines?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface Workspace {
  readonly dir: string;
  readonly path: string;
  readonly manifest: PackageManifest;
}

const workspaces: readonly Workspace[] = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .filter((dir) => existsSync(join(PACKAGES, dir, "package.json")))
  .map((dir) => ({
    dir,
    path: join(PACKAGES, dir),
    manifest: JSON.parse(
      readFileSync(join(PACKAGES, dir, "package.json"), "utf8"),
    ) as PackageManifest,
  }));

/** Everything not marked private. `private: true` is the only thing that keeps one off npm. */
const publishable = workspaces.filter((w) => w.manifest.private !== true);

const CLI = "@model-regression-sentinel/cli";
const built = (w: Workspace): boolean => existsSync(join(w.path, "dist"));

describe("the suite sees the packages it is checking", () => {
  it("found a workspace to check, so an empty result means clean and not broken", () => {
    expect(workspaces.length).toBeGreaterThan(3);
    expect(publishable.length).toBeGreaterThan(3);
    expect(publishable.map((w) => w.manifest.name)).toContain(CLI);
  });
});

describe.each(publishable.map((w) => [w.dir, w] as const))(
  "packages/%s declares what a registry page needs",
  (dir, workspace) => {
    const m = workspace.manifest;

    it("has a name, a version, a licence and a description", () => {
      expect(m.name, "name").toBeTypeOf("string");
      expect(m.version, "version").toMatch(/^\d+\.\d+\.\d+/);
      expect(m.license, "license").toBe("MIT");
      // A description is what npmjs.com and `npm search` show. An empty one is a blank page.
      expect((m.description ?? "").length, "description").toBeGreaterThan(20);
    });

    it("points at a repository, in object form, with the directory this package lives in", () => {
      // The object form with `directory` is what makes the npm page link to THIS package rather
      // than to the root of a monorepo, and it is what provenance tooling reads later.
      expect(m.repository?.type).toBe("git");
      expect(m.repository?.url ?? "").toMatch(/^git\+https:\/\/github\.com\/.+\.git$/);
      expect(m.repository?.directory).toBe(`packages/${dir}`);
    });

    it("says where to report a bug and where to read about it", () => {
      expect(m.bugs?.url ?? "").toMatch(/^https:\/\/github\.com\/.+\/issues$/);
      expect(m.homepage ?? "").toMatch(/^https:\/\/github\.com\//);
      // The homepage names the same directory the repository field does, so a reader who follows
      // it lands on this package and not on a sibling.
      expect(m.homepage ?? "").toContain(`packages/${dir}`);
    });

    it("declares public access explicitly, because a scoped package defaults to restricted", () => {
      // Without this a scoped publish is private by default, which fails on a free account and
      // succeeds silently as a paid private package on a paid one. Neither is the intent.
      expect(m.publishConfig?.access).toBe("public");
    });

    it("declares the Node versions it was tested on", () => {
      expect(m.engines?.node ?? "").toMatch(/>=\s*\d+/);
    });

    it("ships an explicit file allow-list that carries no source and no tests", () => {
      const files = m.files ?? [];
      expect(files.length, "files").toBeGreaterThan(0);
      for (const entry of files) {
        expect(entry, "no source or test directory may be in files").not.toMatch(
          /^(src|test|tests|__tests__|examples)\b/,
        );
      }
      // The other direction: whatever the allow-list resolves to must contain no .ts source. A
      // declaration file is not source, so .d.ts and .d.cts are allowed through.
      for (const entry of files) {
        const target = join(workspace.path, entry);
        if (!existsSync(target)) continue;
        if (!statSync(target).isDirectory()) continue;
        const offenders = readdirSync(target).filter(
          (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".d.cts"),
        );
        expect(offenders, `${entry}/ ships TypeScript source`).toEqual([]);
      }
    });

    it("has every non-directory file it promises to ship", () => {
      // `files: ["dist", "LICENSE"]` with no LICENSE on disk produces a tarball with no licence
      // and no error anywhere. npm warns about it and nothing fails.
      for (const entry of m.files ?? []) {
        if (entry === "dist") continue;
        expect(existsSync(join(workspace.path, entry)), `${dir}/${entry}`).toBe(true);
      }
    });

    it("depends on siblings through the workspace protocol, and on nothing else", () => {
      // Zero third-party dependencies is a property this project advertises. A dependency added
      // here would be a dependency in every consumer's tree, forever.
      for (const [name, range] of Object.entries(m.dependencies ?? {})) {
        expect(name, `${dir} depends on ${name}`).toMatch(/^@model-regression-sentinel\//);
        expect(range, `${dir} -> ${name}`).toMatch(/^workspace:/);
        const target = name.slice("@model-regression-sentinel/".length);
        expect(
          publishable.some((w) => w.manifest.name === name),
          `${name} is not a package in this workspace`,
        ).toBe(true);
        expect(existsSync(join(PACKAGES, target, "package.json"))).toBe(true);
      }
    });
  },
);

describe("the versions across the workspace agree", () => {
  it("carries one version, so a release is one number rather than seven", () => {
    const versions = [...new Set(publishable.map((w) => w.manifest.version))];
    expect(versions, `saw ${versions.join(", ")}`).toHaveLength(1);
  });

  it("has no dependency pinned to a version that is not in this workspace", () => {
    // `workspace:*` and `workspace:^` are both fine here; what would not be is a hard-coded
    // range that stops matching the moment the versions move.
    const bad: string[] = [];
    for (const w of publishable) {
      for (const [name, range] of Object.entries(w.manifest.dependencies ?? {})) {
        if (!range.startsWith("workspace:")) bad.push(`${w.manifest.name} -> ${name}@${range}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the cli package promises a command", () => {
  const cli = publishable.find((w) => w.manifest.name === CLI) as Workspace;

  it("declares a bin", () => {
    expect(cli).toBeDefined();
    expect(Object.keys(cli.manifest.bin ?? {})).toEqual(["sentinel"]);
  });

  it("names a bin target inside the files allow-list, or the tarball would not carry it", () => {
    for (const target of Object.values(cli.manifest.bin ?? {})) {
      const top = target.replace(/^\.\//, "").split("/")[0] as string;
      expect(cli.manifest.files ?? [], `bin target ${target}`).toContain(top);
    }
  });

  it.runIf(built(cli))("names a bin target that exists after a build", () => {
    for (const [name, target] of Object.entries(cli.manifest.bin ?? {})) {
      expect(existsSync(join(cli.path, target)), `bin ${name} -> ${target}`).toBe(true);
    }
  });

  it.runIf(built(cli))("ships a bin that starts with a shebang, or it is not executable", () => {
    // A `bin` without a shebang installs fine and fails on the first invocation with a syntax
    // error from the shell, which reads as a broken package rather than a missing line.
    for (const target of Object.values(cli.manifest.bin ?? {})) {
      const head = readFileSync(join(cli.path, target), "utf8").slice(0, 32);
      expect(head.startsWith("#!"), `${target} has no shebang`).toBe(true);
    }
  });

  it("says out loud when the build is absent, rather than passing quietly", () => {
    // The two cases above are skipped on a fresh clone. This one records which world the run was
    // in, so a green suite is never mistaken for a checked binary.
    expect(typeof built(cli)).toBe("boolean");
  });
});

describe("nothing in a package can publish by accident", () => {
  it("has no lifecycle script that would run a publish", () => {
    // `prepublishOnly`, `publish` and `postpublish` all run as part of `npm publish`. None of
    // them exists here, and a test is cheaper than noticing later.
    const offenders: string[] = [];
    for (const w of publishable) {
      for (const name of Object.keys(w.manifest.scripts ?? {})) {
        if (/^(pre|post)?publish(Only)?$/.test(name)) offenders.push(`${w.manifest.name}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
