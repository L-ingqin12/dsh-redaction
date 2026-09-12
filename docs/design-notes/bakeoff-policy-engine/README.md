# @yourorg/dsh-redaction

A rule-driven **redaction policy engine** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one config schema, one npm package, preventive interception plus an append-only
audit ledger, and an honest account of what cannot be undone.

---

## 1. What it does

| Surface | Hook | Rewrites? | Why |
|---|---|---|---|
| User input | `agent/pre-step` (waterfall) | **yes** — replaces `messages` | runs on step admission, *before* the accepted user batch is committed |
| Tool results | `tools/post-execute` (waterfall) | **yes** — replaces `content` | `value` and `content` are mutually exclusive in one decision; we replace content only |
| PTC durable log | `tools/ptc-dispatch-log` (waterfall) | **yes** — replaces blocks | the one hook that shapes what a `run_code` sub-call writes to the log |
| Tool arguments | `tools/pre-execute` (waterfall) | **no** — deny/ask only | the registry documents that arguments are already logged and presented by then |
| Model request | `llm/stream` (waterfall) | **no** | a loop-built request is deep-frozen: "listeners read it, never rewrite it" |
| Durable log | `session/event` (emit) | **no** | post-commit firehose; the payload is "the event, exactly as recorded" |

The last two rows are the design. There is no pre-append hook for the durable
event log, so **prevention happens upstream of the append** and history can only
be *remediated* out of band. Everything downstream of that fact is in §6.

---

## 2. Install — the stranger's journey

Prerequisites: Node ≥ 22.19, `pnpm` on `PATH` (`dsh plugin` is a thin pnpm
forwarder and exits 127 with `pnpm not found on PATH` without it), and a DSH
profile you already run.

```sh
# 1. Install the bundle into a profile. This initializes the profile on first
#    use, shells out to pnpm inside it, then reconciles dsh.profile.bundles.
dsh plugin --profile dsh-tui add @yourorg/dsh-redaction

# 2. Confirm the layer joined the stack. The plugin command appends any
#    dependency whose manifest declares `dsh.bundle.patch`; a package without
#    that key installs as a plain dependency and prints a warning instead.
cat ~/.dsh/profiles/dsh-tui/package.json    # dsh.profile.bundles must list it

# 3. Confirm the row composes. This is the same single applyEntryPatches call
#    the boot include makes, so the dump cannot drift from what mounts.
dsh --profile dsh-tui --dump-config | grep -A12 '^# == @yourorg/dsh-redaction'

# 4. Lint the policy before trusting it.
npx dsh-redact lint --profile dsh-tui

# 5. Restart the profile. Config is composed at boot.
```

Ships **inert**: the patch inserts the row with `rules: []`, so the engine mounts,
proves it is alive in the ledger, and redacts nothing until you name a detector.
That mirrors the platform's own `dsh-spill-policy` ("omitted `maxInlineBytes` ⇒
the plugin registers nothing").

### Verify

```sh
dsh-redact schema                 # the document's JSON schema envelope
dsh-redact lint --profile dsh-tui # unknown keys, dangling detector refs, ...
```

`lint` exists because **Schemastery silently drops unknown keys**. A typo'd
YAML key is not an error — it is a policy that under-enforces while reporting
success. Verified:

```
Config({ mode: "enforce", bogusKey: 1 })  =>  { schemaVersion: 1, mode: "enforce", ... }   // bogusKey gone, no throw
```

### Uninstall

```sh
dsh plugin --profile dsh-tui remove @yourorg/dsh-redaction
# reconcilePlugins drops the bundle from dsh.profile.bundles on the next run
dsh --profile dsh-tui --dump-config | grep redaction   # expect no match
```

`remove` withdraws the provider on the next profile start. Existing ledger rows
and any derived sessions are left behind deliberately — deleting an audit trail
on uninstall would defeat its purpose.

---

## 3. Configuration

The row's `config` is the whole policy document. Every field is optional with a
schema default, so a partial YAML override stays coherent — which matters
because **a patch replaces the matched row's entire `config` rather than merging
into it**.

### 3.1 Posture

| Field | Type | Default | Meaning |
|---|---|---|---|
| `schemaVersion` | number | `1` | The policy document's own version. Independent of the package version and of the session format version. |
| `mode` | `enforce` \| `dry-run` \| `off` | `enforce` | `dry-run` scans, records to the ledger, and returns the content **unchanged** — the shadow-mode rollout. `off` returns from `apply()` before any listener is registered. |
| `onError` | `fail-closed` \| `fail-open` | `fail-closed` | What a *scanner* failure does. `fail-closed` blocks; `fail-open` passes and warns. |

### 3.2 Surfaces

| Field | Default | Meaning |
|---|---|---|
| `surfaces.userInput` | `true` | Scan messages entering a step (`agent/pre-step`). |
| `surfaces.toolResults` | `true` | Scan tool result content (`tools/post-execute`). |
| `surfaces.ptcLog` | `true` | Scan the durable copy of a `run_code` sub-call result. |
| `surfaces.toolArgs` | `true` | Detect in tool arguments and deny — **never rewrite**, because those arguments are already logged. |

### 3.3 Detectors

```yaml
detectors:
  - id: aws                      # required, stable; referenced by rules and by the ledger
    kind: builtin                # builtin | regex | entropy
    name: aws-access-key-id      # builtin only
    confidence: high             # low | medium | high
  - id: acme-key
    kind: regex
    pattern: 'ACME-[0-9a-f]{32}' # compiled ONCE at mount; an invalid pattern fails the mount loudly
    flags: g
  - id: high-entropy
    kind: entropy
    minBitsPerChar: 3.5
    minLength: 20
    alphabet: base64             # base64 | hex | alnum
```

Ships these builtins: `private-key-pem`, `jwt`, `aws-access-key-id`,
`github-token`, `slack-token`, `bearer-token`, `generic-api-key`, `email`,
`credit-card`, `cn-id-card`, `ipv4`.

A bad pattern or an unknown builtin **throws from `apply()`**. Schemastery
cannot compile a RegExp, so mount time is the earliest judgement point; a policy
that silently dropped an uncompilable rule would enforce nothing while looking
healthy.

### 3.4 Rules — first match wins per span

```yaml
rules:
  - id: no-provider-keys
    description: Never let a provider credential reach the model or the log
    when:
      detectors: [aws, jwt, private-key-pem]   # ['*'] = every detector
      tools: []                                # empty = every tool; '*' also matches all
      agents: []                               # empty = every agent
      surfaces: []                             # empty = every enabled surface
    then:
      action: mask            # redact | mask | hash | tokenize | drop | deny
      replacement: '***'      # {detector} {rule} {digest} interpolate
      keepPrefix: 4
      keepSuffix: 0
      maskChar: '*'
      reason: 'Blocked by the redaction policy.'   # deny only
    audit:
      level: full             # full | metadata | none
  - id: block-secrets-in-shell
    when: { detectors: ['*'], tools: [bash, pwsh] }
    then: { action: deny, reason: 'This command appears to contain a credential.' }
```

`action: deny` on `surfaces: [toolResults]` blocks the result (turning it into an
error with the `reason` as feedback); on `toolArgs` it denies the call before
dispatch. Overlapping spans resolve **longest-match wins, ties by rule order**,
so a broad `email` rule and a narrow `acme-key` rule compose instead of nesting.

### 3.5 Media, limits, notification

```yaml
media:
  images: passthrough     # passthrough | strip | deny
  files:  passthrough
  binary: strip
limits:
  maxScanBytes: 1048576
  onOverflow: fail-closed # fail-closed | fail-open | truncate
  maxReplacementsPerBlock: 1000
notify:
  userVisible: true       # append a short system notice when a redaction happened
  modelVisible: false     # tell the model content was redacted, so it does not retry blindly
```

### 3.6 Audit

```yaml
audit:
  enabled: true
  domain: dsh_redaction_ledger
  hashChain: true         # each record carries prev + hash
  recordDigestOnly: true  # KEYED digest of the match, never the match
  recordSpans: true       # offsets and lengths: reveals shape, not content
  retentionDays: 90
  exportPath: null
```

`recordDigestOnly` defaults on for a blunt reason: **an audit trail that quotes
the secret it caught is a second copy of the secret.**

### 3.7 Remedial

```yaml
remedial:
  enabled: false
  strategy: derive        # derive | export  (in-place scrubbing is CLI-only)
  sessionIds: []
  since: null
  dryRun: true
```

### 3.8 One schema, two editors

`Config.toJSON()` is the schema envelope a configuration surface renders
(verified: 7,938 bytes for this document). Registering the same schema through
`ctx.settings.installSection(...)` layers three sources in order — schema
defaults, the row's composition `config` as the **base**, then the user document
at `$DSH_HOME/settings.yaml` — and falls back to the entry when the settings
provider detaches. A field marked `Schema.role('secret')` is stripped from every
wire view and enumerated as a write-only slot (`dsh-settings`'s `redactSecrets`),
which is the vocabulary this engine reuses rather than reinvents.

---

## 4. Package layout

```
@yourorg/dsh-redaction/
├── package.json          # dsh.bundle.patch + exports + optional peerDependencies
├── cordis.patch.yml      # ONE insert: the `redaction` row
├── src/
│   ├── index.js          # `name`, `inject`, `Config`, `apply`
│   └── config.js         # the Schemastery schema — the single source of truth
├── bin/dsh-redact.js     # remedial CLI: lint | schema | ledger | derive | scrub
└── README.md
```

**Zero build.** The plugin is plain ESM JavaScript, so `main` points straight at
`src/index.js` and there is no build step to get wrong. A TypeScript author
compiles to `lib/` and points `main`/`exports` there instead — DSH never
transforms your module, so whatever `main` resolves to must already be runnable
by Node with no bundler.

Only **two** manifest details are enforced by code:

```jsonc
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },  // 1. what makes it a LAYER
  "files": ["lib", "bin", "cordis.patch.yml", "README.md", "LICENSE"]  // 2. the patch must ship
}
```

`dsh plugin`'s reconcile step tests exactly `manifest.dsh?.bundle?.patch !== undefined`
to decide whether a dependency joins `dsh.profile.bundles`; the loader then joins
the declared path onto the resolved package directory and parses it. Everything
else below is **convention, not contract** — `exports["./cordis.patch.yml"]` and
`exports["./package.json"]` are not consulted (the loader resolves the package
directory through `createRequire(...).resolve.paths(...)` precisely so that a
package need not export `./package.json`). Keep them anyway: they cost nothing
and they make the package legible.

```jsonc
{
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",   // convention only
    "./package.json": "./package.json"            // convention only
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true },
    "@deepseek-ai/schemastery": { "optional": true }
  }
}
```

Note the asymmetry with the vendor's own `dsh-base`: its patch **never names
itself**, because that package carries no runtime API. This one does name itself
in the row's `name:`, so its `main`/`exports["."]` *is* load-bearing.

**Never move `@deepseek-ai/cordis` into `dependencies`.** Bare specifiers resolve
from the profile directory, which falls back to `$DSH_HOME/profiles/node_modules`
— a symlink farm over the running installation's dependency closure (249 entries
on the machine this was verified against). A second copy of `cordis` is a second
`Service` base class and a different `Context`, and the loader's fiber wiring
breaks. Declaring them as **optional** peers is also required because profile
`pnpm-workspace.yaml` sets `autoInstallPeers: false`.

---

## 5. Publishing

```sh
# 1. Prove the tarball carries what the loader needs: package.json, the patch,
#    and a runnable entry — nothing else is enforced.
npm pack --dry-run

# 2. Publish. `access: public` is required for a scoped package.
npm publish --access public
```

Notes that cost real debugging time:

- **Publish under your own scope.** `@deepseek-ai/*` is the vendor's.
- **Version deliberately.** Every published `@deepseek-ai/dsh-*` build so far is
  a *prerelease*, and dist-tags are skewed: `@deepseek-ai/dsh-base`'s `latest`
  is `0.0.1-rc.1` while its `next` is `0.1.5-rc.2`. A bare `npm i
  @deepseek-ai/dsh-base` resolves to a months-old build.
- **Do not pin `^0.1.x-rc.y` and expect to follow the harness.** Verified with
  `semver@7.8.5`: `satisfies('0.1.5-rc.1', '^0.1.1-rc.1') === false`, and
  `maxSatisfying(<all published versions>, '^0.1.1-rc.1') === '0.1.1-rc.2'`.
  Prerelease matching requires a comparator with the same `[major,minor,patch]`
  tuple, so `^0.1.1-rc.1` can never select `0.1.5-rc.1`. If you must peer-pin,
  enumerate the line explicitly the way `@deepseek-harness-tui/dsh-tui` does:
  `"^0.1.0-rc.6 || ^0.1.1-rc.1 || 0.1.2-alpha.3 || ... || 0.1.5-rc.1"`.
  Better: declare the peer `optional`, read capabilities at runtime, and keep
  the dependency surface to `node:` builtins.
- **A git-hosted plugin builds via its `prepare` script, which pnpm blocks.**
  `dsh plugin` says so explicitly and tells the user to add the printed key
  under `allowBuilds` in the profile's `pnpm-workspace.yaml`
  (`allowBuilds:\n  your-plugin: true`). Prefer a published tarball with `lib/`
  pre-built, or a `pnpm pack` tarball, so a stranger never needs a build grant.
  If you must use a git spec, pin a commit.
- **Windows: a missing `pnpm` produces a misleading error.** The forwarder spawns
  with `shell: process.platform === 'win32'`, so a missing binary yields
  `status: 1` rather than `error.code === 'ENOENT'` — the friendly
  `pnpm not found on PATH` branch is unreachable and the user sees only
  `dsh: pnpm failed in profile directory <dir>`. Document `pnpm` as a hard
  prerequisite.
- **Windows: git specs go through `cmd.exe`, where `&` is a separator.** Use the
  `#path:` form rather than `#main&path:`.
- Local development is `dsh plugin --profile <name> add file:/abs/path` —
  absolute specs pass through untouched, while a bare `.` or `../plugin` is
  rewritten against your invoking directory (pnpm's cwd is the *profile*
  directory, so `add .` would otherwise self-link the profile).
- **You can read the real implementation.** 228 of the 239 installed
  `@deepseek-ai/*` packages export `./src/*` alongside their build output, so
  `node_modules/@deepseek-ai/dsh-settings/src/*.ts` is reachable when a `.d.ts`
  is not enough. The CLI package itself is the exception: no `exports`, no
  `main`, `bin` only — `@deepseek-ai/dsh` is not importable as a library.
- **The author guide exists, but not where you installed from.**
  `docs/user/develop/basic/index.md` (*Your first plugin*) and
  `docs/user/develop/basic/publish.md` (*Package and install a plugin*) live in
  the repository. The published `dsh` tarball is 10 files, so its own README
  links dangle. Read the repo.

---

## 6. Compatibility risks — read this before depending on it

1. **The harness is an explicit developer preview.** Its README states:
   *"DeepSeek Harness is in developer preview and iterating rapidly. **THERE
   WILL BE COMPATIBILITY-BREAKING CHANGES.**"* Treat every hook name, config key,
   and event signature below as unstable.
2. **Config keys have already been renamed inside the rc line.**
   `dsh-system-prompt` moved `persona` → `personaPrefix` at `0.1.3-alpha.2`.
   Consumers cope by probing the installed version *inside a `!!js` expression in
   YAML* — a real bundle does exactly that. Budget for the same trick, or read
   capabilities instead of versions.
3. **The plugin-author documentation is not in the tarballs.** The `dsh` npm
   package ships 10 files; its README links to docs that are not published with
   it, so those links dangle for anyone who only `npm i`'d it. Read the
   repository, not the installed package.
4. **A patch replaces a row's whole `config`.** Your defaults are what keep a
   partial user override from silently disabling half the policy.
5. **Unknown config keys are silently dropped.** Run `dsh-redact lint`.
6. **A missing row target warns on every boot** (`patch: entry "..." not found`)
   and does nothing. If you insert rows, nobody's later patch can be relied on
   to remove them by a name you invented.
7. **Loader entry ids are process-global.** Two bundles cannot both own the id
   `redaction`. A third-party bundle that must coexist with a possible official
   row should use a scoped id and a self-disabling `!!js` guard, as
   `@deepseek-harness-tui/dsh-tui` does for `storage`/`workspace`/`agent-presets`.
8. **Row names resolve from the profile directory.** Under pnpm's layout a
   *transitive* dependency of your package is not linked into the profile root,
   so naming one as a row `name:` fails with `ERR_MODULE_NOT_FOUND` and disposes
   the tree at boot. Re-export what you need through your own `exports` subpaths.
9. **Entry-level `inject:` in the patch and code-level `inject` in the module are
   separate.** A patch read from an older copy of the package than the module it
   loads can deadlock the tree at boot on a service that will never appear.
   Keep `inject` minimal: this engine declares none.
10. **This is a control, not a boundary.** The row lives in a *patch layer*, and
    `dsh.profile`, `$DSH_HOME/cordis.patch.yml` and `--patch` all outrank it. The
    owner of the machine can always disable it. That is why the ledger is
    **hash-chained**: the product promise is *detectability*, not prevention.
11. **The engine cannot rewrite `llm/stream` or the durable log.** A loop-built
    request is deep-frozen, and `session/event` fires after the append. Redaction
    of anything that already reached storage is `derive` (a clean copy) or
    `scrub` (offline frame surgery) — never a live in-place edit.
12. **`scrub` is format-sensitive.** `session.v3.jsonl.zstd` is a concatenation
    of independent checksummed Zstandard frames; DSH writes them with
    `ZSTD_c_checksumFlag: 1`. Editing bytes inside a frame without recompressing
    and recomputing its checksum yields a file the reader rejects.
13. **The engine's own hot path is the tool pipeline.** `tools/post-execute` runs
    for every tool result. Compile regexes once (done), keep the ledger off the
    synchronous path (done), and respect `limits.maxScanBytes`.

---

## 7. Licence

MIT.
