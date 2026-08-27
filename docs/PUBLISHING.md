# Publishing

> [!CAUTION]
> # DO NOT PUBLISH WITHOUT EXPLICIT APPROVAL
>
> **No package in this repository may be published to npm unless the repository owner has said so,
> in words, for this specific release. NO AGENT MAY PUBLISH THESE PACKAGES, under any circumstances,
> for any reason.** A green checklist is not approval. A passing `audit:release` is not approval. An
> agent concluding that every gate passed is not approval, and no agent may run `npm publish`,
> `pnpm publish` or `changeset publish`, with or without flags, ever.
>
> Publishing is the one step here that cannot be undone. npm's unpublish window is 72 hours and it
> leaves the name permanently unusable for a fresh package. Everything else in this repository is
> reversible; this is not.
>
> **The credential is present on the machine this pass ran on.** `~/.npmrc` carries an npm auth
> token, so a stray `npm publish` would not be stopped by a missing login the way it would be on a
> clean machine. The root `package.json` also carries `"release": "changeset publish"`, which is one
> mistyped script name away from the irreversible thing. Treat both as loaded.
>
> What is genuinely safe: there is no release workflow in `.github/workflows/` (the only workflow is
> `ci.yml`), no `NPM_TOKEN` anywhere in the repository or in CI, and `.changeset/config.json` sets
> `"commit": false`. Nothing publishes on its own. Every step below is a human typing a command.

**State as of the v0.2 hardening pass: NOT a publish candidate.** Packaging is verified, all seven
tarballs pack, all seven `npm publish --dry-run` invocations succeed, and a staged install of the
seven together works from a directory that has never seen this workspace. It is still not
publishable, for the five reasons under [Blockers](#blockers-measured-not-assumed). Nothing has ever
been published.

Every factual claim in this file was produced by a command, and the command is written next to it.
Registry and repository state move; **re-run them rather than trusting the date**. Everything below
was measured on 2026-08-26 with npm 10.9.4, pnpm 10.33.0 and Node 22.22.1.

## The seven packages

| package | directory | tarball | packed | unpacked | files | registry, direct fetch |
| --- | --- | --- | --- | --- | --- | --- |
| `@model-regression-sentinel/spec` | `packages/spec` | `model-regression-sentinel-spec-0.1.0.tgz` | 96.8 kB | 320.6 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/run` | `packages/run` | `model-regression-sentinel-run-0.1.0.tgz` | 83.3 kB | 304.9 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/baseline` | `packages/baseline` | `model-regression-sentinel-baseline-0.1.0.tgz` | 30.6 kB | 106.3 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/detect` | `packages/detect` | `model-regression-sentinel-detect-0.1.0.tgz` | 173.0 kB | 645.0 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/report` | `packages/report` | `model-regression-sentinel-report-0.1.0.tgz` | 105.5 kB | 418.3 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/watch` | `packages/watch` | `model-regression-sentinel-watch-0.1.0.tgz` | 68.1 kB | 230.5 kB | 8 | `404`, unpublished |
| `@model-regression-sentinel/cli` | `packages/cli` | `model-regression-sentinel-cli-0.1.0.tgz` | 43.9 kB | 182.3 kB | 16 | `404`, unpublished |

Sizes are from `npm pack --dry-run` in each directory and they move with every build. The cli ships
sixteen files rather than eight because it builds two entry points, `index` and `cli`, in both module
formats.

Reproduce the sizes:

```sh
for p in spec run baseline detect report watch cli; do
  (cd "packages/$p" && npm pack --dry-run 2>&1 | grep -E 'name:|package size:|total files:')
done
```

Reproduce the registry column, which is the only command here that touches the network:

```sh
for p in spec run baseline detect report watch cli; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' \
    "https://registry.npmjs.org/@model-regression-sentinel%2f$p"
done                        # every line must print 404
```

> [!IMPORTANT]
> **A `404` is not a reservation.** It proves the name was unpublished at the instant an
> unauthenticated client asked, and nothing more. Anyone can take any of these seven names before you
> do. Re-fetch all seven immediately before publishing.

The repository the manifests point at exists and is public:
`api.github.com/repos/mstevens843/model-regression-sentinel` returns `200`. Every `repository`,
`bugs` and `homepage` field is checked field by field by `packages/cli/test/packaging.test.ts`, which
runs in `pnpm test` and never touches the network.

## Blockers, measured and not assumed

**1. Not one package has a README.** `files` is `["dist", "LICENSE"]` in all seven manifests and
there is no `packages/*/README.md` in the repository. npmjs.com renders a package's README as its
entire page, so all seven would publish as blank pages, and the root `README.md` is not shipped in
any tarball. This is the largest blocker and it is prose work rather than tooling work.

```sh
ls packages/*/README.md            # no matches
npm pack --dry-run 2>&1 | grep -i readme    # in any package: nothing
```

**2. `npm publish` would ship the `workspace:` protocol verbatim and break every install.** All six
inter-package dependencies use `workspace:^`. `npm pack` copies that string into the tarball, and
installing such a tarball fails immediately:

```sh
cd packages/cli && npm pack --pack-destination /tmp/x
tar -xzOf /tmp/x/model-regression-sentinel-cli-0.1.0.tgz package/package.json | grep workspace
#   "@model-regression-sentinel/spec": "workspace:^"      <- shipped verbatim

cd "$(mktemp -d)" && npm init -y && npm install /tmp/x/model-regression-sentinel-cli-0.1.0.tgz
#   npm error code EUNSUPPORTEDPROTOCOL
#   npm error Unsupported URL Type "workspace:": workspace:^
```

`pnpm pack` rewrites it, which is why `scripts/build-release.mjs` uses pnpm and refuses to fall back
to npm:

```sh
cd packages/cli && pnpm pack --pack-destination /tmp/y
tar -xzOf /tmp/y/model-regression-sentinel-cli-0.1.0.tgz package/package.json | grep spec
#   "@model-regression-sentinel/spec": "^0.1.0"           <- a real range
```

So: **publish with `pnpm exec changeset publish`, which delegates to `pnpm publish`. Never with
`npm publish`.** Step 7 of the gate below is `--dry-run` only for exactly this reason.

**3. The cli cannot be installed alone until its six siblings are on the registry.** Even packed by
pnpm, a lone cli tarball resolves `@model-regression-sentinel/baseline@^0.1.0` from npm and gets a
404. That is not a defect, it is the state of an unpublished workspace, and it means the only
install that can be smoke tested before a publish is a staged one:

```sh
cd "$(mktemp -d)" && npm init -y
npm install /tmp/y/model-regression-sentinel-cli-0.1.0.tgz
#   npm error code E404
#   npm error 404 '@model-regression-sentinel/baseline@^0.1.0' is not in this registry.
```

**4. There is no changeset, so there is no decided version.** `.changeset/` holds only
`config.json`. All seven packages sit at `0.1.0` and `changeset publish` would publish that number
as it stands. Whether `0.1.0` is the honest first public number for something whose own README opens
with "this tool has never observed a real provider regression" is a judgement, and it has to be made
rather than defaulted into.

**5. The corpus freeze is `UNAVAILABLE` and `pnpm verify:freeze` exits non-zero by design.** That is
correct and it is checked as an inverted negative control in `scripts/audit-release.sh`: if
`verify:freeze` ever starts passing, either somebody cashed the proof properly or somebody weakened
the check. Not a packaging blocker, and it is a disclosure requirement: a consumer arriving from
npmjs.com must be able to find `docs/FREEZE.md` from whatever README step 2 of the gate produces.

## The release gate, in order

In this order, in one sitting, on one clean checkout. "It passed yesterday" is not a checked box.

1. [ ] **Read the seven names, as a human, and decide.** They are permanent.

   ```sh
   grep -h '"name"' packages/*/package.json
   ```

2. [ ] **Write a README for every package** (blocker 1) and add it to `files`. Each one is read out
   of the context of this repository, so each needs its own opening paragraph, its own install
   snippet, a link to `docs/LIMITATIONS.md` and `docs/FREEZE.md`, and a "nothing here is published
   yet" note that becomes false the moment step 11 succeeds.

3. [ ] **Re-fetch every name, and confirm the account.** Availability measured on another day is not
   availability.

   ```sh
   for p in spec run baseline detect report watch cli; do
     printf '%s -> ' "$p"
     curl -s -o /dev/null -w '%{http_code}\n' \
       "https://registry.npmjs.org/@model-regression-sentinel%2f$p"
   done                      # every line must print 404

   npm whoami                # the right account, and nothing else
   npm profile get           # two-factor auth must read auth-and-writes
   ```

4. [ ] **Install, lint, typecheck, build**, from a clean checkout.

   ```sh
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm typecheck
   pnpm build                # 7 packages, dist/ for each
   ```

5. [ ] **Test, then run the audit and watch both negative controls fire.** A gate that cannot fail
   proves nothing about what it gates.

   ```sh
   pnpm test
   pnpm audit:release        # must end "All gates green, and both negative controls fired."
   ```

   Inside that audit: a deliberately corrupted corpus **must** be rejected by `verify:corpus`, and
   `verify:freeze` **must** exit non-zero. If either stops failing, stop and find out why before
   fixing anything else.

6. [ ] **Build the release payload and verify it, then verify it again without this project's code.**

   ```sh
   node scripts/build-release.mjs
   pnpm exec sentinel release verify dist/release     # exit 0, and it names the directory it checked
   cd dist/release && shasum -a 256 -c MANIFEST.sha256 && cd ../..
   ```

   `release verify` checks a written-down list of required artifacts **against the filesystem**
   rather than against the manifest, because a builder that never wrote an artifact produces a
   manifest that does not mention it, and every manifest-versus-payload cross-check then agrees.

7. [ ] **Dry-run each package and read the file list yourself.** A human should look at it once
   before the first publish of anything, ever. `--dry-run` is not optional in this step: `npm
   publish` here would ship the `workspace:` protocol.

   ```sh
   for p in spec run baseline detect report watch cli; do
     (cd "packages/$p" && npm pack --dry-run && npm publish --dry-run --access public)
   done
   ```

   Both are safe: `--dry-run` reports what it would have done and makes no publish request. Every
   one of the seven succeeds today without any credential.

8. [ ] **Staged install smoke: pack all seven with pnpm, install them together into a scratch
   directory, and run the installed binary.** This is the closest thing to a real consumer install
   that is possible before publishing, because none of the seven is on the registry yet.

   ```sh
   stage="$(mktemp -d)"; dest="$(mktemp -d)"
   for p in spec run baseline detect report watch cli; do
     (cd "packages/$p" && pnpm pack --pack-destination "$stage")
   done
   cd "$dest" && npm init -y && npm install "$stage"/*.tgz
   ./node_modules/.bin/sentinel --help; echo "exit $?"     # must be 0
   ```

   Measured on 2026-08-26: `added 7 packages`, and `sentinel --help` exits **0** from a directory
   that has never seen this workspace. The same run also confirms the `bin` link is created and the
   shipped `dist/cli.js` carries its shebang.

9. [ ] **Version with changesets**, then rebuild and re-verify against the numbers it just wrote.

   ```sh
   pnpm changeset                         # write one, deliberately (blocker 4)
   pnpm exec changeset status --verbose
   pnpm exec changeset version
   pnpm build                             # never publish a dist/ built from the old versions
   pnpm test && node scripts/build-release.mjs && pnpm exec sentinel release verify dist/release
   ```

10. [ ] **Get explicit approval from the repository owner, for this release, in words.** See the
    block at the top of this file. It is a separate step because it is a separate decision, and
    because nine ticked boxes is exactly the state in which it is easiest to skip.

11. [ ] **Publish. Only after step 10, only by a human, and only with pnpm.**

    ```sh
    pnpm exec changeset publish     # delegates to pnpm publish, rewriting workspace: ranges
    git push --follow-tags
    ```

    `changeset publish` orders the packages so a dependency is never published after its dependents.
    Publishing one at a time by hand, in the wrong order, leaves a package on the registry pointing
    at a version that does not exist.

12. [ ] **Immediately after: install from the registry into a scratch directory, and run it.** This
    is the only check that a real install of a real published tarball works, and no amount of local
    verification substitutes for it.

    ```sh
    cd "$(mktemp -d)" && npm init -y
    npm install @model-regression-sentinel/cli
    ./node_modules/.bin/sentinel --help; echo "exit $?"
    ```

    Then delete the "nothing here is published yet" notes from the seven READMEs, which became false
    the moment step 11 succeeded, and publish the patch that removes them.

## The `workspace:` protocol, and what each form ships

Verified by packing this repository and reading the manifest back out of the tarball, rather than by
asserting what a packer ought to do.

| source range | what pnpm ships | consequence |
| --- | --- | --- |
| `workspace:*` | `"@model-regression-sentinel/spec": "0.1.0"` | an **exact pin**. A consumer on any other version gets a second copy in the tree, and the types that cross the package boundary stop being the same types. |
| `workspace:^` | `"@model-regression-sentinel/spec": "^0.1.0"` | a range. One copy, deduplicated, patches allowed. |
| any, via `npm pack` | `"@model-regression-sentinel/spec": "workspace:^"` | **unresolvable.** Every consumer's install fails with `EUNSUPPORTEDPROTOCOL`. |

All six inter-package dependencies here use `workspace:^`.
`packages/cli/test/packaging.test.ts` asserts that every inter-package dependency uses the
`workspace:` protocol rather than a hard-coded range, and `scripts/build-release.mjs` reads the
resolved range back out of every packed tarball before it will write a release.

## What publishing would and would not prove

Publishing proves that seven tarballs upload and that a consumer can install them. That is all it
proves.

It proves nothing about any claim in [../RESULTS.md](../RESULTS.md), and it retires no line of
[LIMITATIONS.md](./LIMITATIONS.md). At this freeze those still say: **this tool has never observed a
real provider regression**; the corpus is 34 cases against one provider family; the ordering proof
behind the corpus freeze is `UNAVAILABLE` and will stay that way in this repository; and the
calibration was collected in one week of one provider's behavior.

A published package with a green CI badge reads as a proven one. Publish because the packaging is
honest and someone can run a drift check against a frozen corpus and get an exit code that means
what it says, not because a registry page implies the instrument has been validated in the field. It
has not.

## Publishing from CI, later

If this ever moves into GitHub Actions, publish with npm provenance via OIDC rather than a
long-lived `NPM_TOKEN`. It produces a verifiable link between the tarball and the workflow run that
built it, and it removes the single credential in this process that is worth stealing. That is a
change to `.github/workflows/`, not to any command above.

Until then, the honest description of this repository's release automation is that there is none,
and the honest description of its release policy is the block at the top of this file.
