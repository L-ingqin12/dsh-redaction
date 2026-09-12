# Publishing

Both packages go to the public npm registry under unscoped names. Neither has runtime dependencies; the only `peerDependencies` are optional.

## Before you start

Node **>= 22.15** must be first on `PATH`. This is not a formality: `prepublishOnly` runs `npm test`, which spawns `node`, and the engine uses the zlib zstd API that only landed in 22.15. With an older Node on `PATH` the publish fails — deliberately, with an explicit message rather than a misleading "corrupt log" error.

```bash
node -v   # must print v22.15.0 or newer
```

## Log in (once per machine)

```bash
npm login --registry=https://registry.npmjs.org/
```

## Publish

Each `package.json` pins `publishConfig.registry` to `https://registry.npmjs.org/`, so a local mirror in your `.npmrc` cannot redirect the upload. Passing `--registry` as well is redundant but makes the intent visible in your shell history:

```bash
cd packages/dsh-plugin-redact
npm publish --registry=https://registry.npmjs.org/

cd ../dsh-plugin-content-policy
npm publish --registry=https://registry.npmjs.org/
```

`prepublishOnly` runs `npm test` first and aborts the upload if anything fails. You can inspect what would ship at any time, without publishing and without credentials:

```bash
npm pack --dry-run                          # the exact file list and size
npm publish --dry-run                       # the same, plus the prepublish gate
node ../../.github/scripts/pack-check.mjs   # fails if a shipped import is missing from `files`
```

## After publishing

```bash
npm view dsh-plugin-redact version
npm view dsh-plugin-content-policy version
```

Then confirm a genuine consumer install works from the registry rather than from disk:

```bash
cd "$(mktemp -d)" && npm init -y
npm install dsh-plugin-redact
node -e "import('dsh-plugin-redact').then(m => console.log(m.name, typeof m.apply))"
```

## Versioning

Both packages are pre-1.0 and versioned independently. Bump with `npm version patch|minor` inside the package directory, commit, and push. Get CI green *before* publishing: a published tarball cannot be edited, only superseded, and `npm unpublish` is restricted after 72 hours.

## What gets published, and why the tests are in there

The `files` allowlist in each `package.json` is the source of truth, and `pack-check.mjs` enforces that it covers every relative import reachable from the entry points — a missing entry there is invisible locally and only the consumer sees it.

The test suites ship on purpose. `npm test` inside an installed copy is reproducible evidence for anyone auditing a tool whose entire job is rewriting session logs: they can run the same assertions against the bytes they received, not against a repository they have to trust.

## Getting listed in the community catalogues

There is **no official DSH plugin marketplace**. DeepSeek ships only the CLI:

```bash
dsh plugin --profile <name> add <spec>
```

Everything else is community-run, and none of it claims official endorsement. Reassuringly, that means listing requires no gatekeeper — but the catalogues do not share a single submission process, so it helps to know what they actually scan for.

**Two signals cover almost all of them:**

| Signal | Where it goes |
|---|---|
| GitHub topic **`dsh-plugin`** on a public repo | dshfind, plugin.dshdesk.com, the YELEBAI marketplace, DSH-Store, dshpluginleaderboard |
| npm keyword **`dsh-plugin`** | harnessai.io's scanner |

Neither is a name prefix — a package does **not** need to be called `dsh-plugin-*` to be indexed.

```bash
gh repo edit <owner>/<repo> --add-topic dsh-plugin --add-topic dsh --add-topic deepseek-harness
```

**The manifest gate** decides whether a listing is merely browsable or actually one-click installable (`manifest_verified`): `package.json` must declare `dsh.bundle.patch`, that file must exist, and it must be a **top-level YAML array** containing a loader entry whose `name` equals the npm package name. `pack-check.mjs` asserts all four, so this cannot silently regress.

Two catalogues additionally want an explicit submission, which only a human can do: <https://www.dsh.so/submit> (returns a security scan) and the "Submit plugin" form on the leaderboard.

A note on trust: these catalogues index what is public. Their presence is not a review — at least one states plainly that listing "does not include code review or runtime verification". Treat a listing as discovery, not as a safety signal, and read the source before installing anything that rewrites your session logs.

