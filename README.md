# dsh-redaction

Two plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), plus the platform research that produced them.

The problem they solve: a public web search, a `gh` command, a log scrape — any tool can return content you must not keep. In DSH that content does not merely pass through: **the stored `tool/result` event *is* the model-facing message**, so one write commits it to both the durable session log and every future provider request. If it is the kind of thing a provider's content filter rejects, that turn fails — and so does every turn after it, because the history keeps carrying it.

## The two packages

| Package | Layer | What it does |
|---|---|---|
| [`dsh-plugin-content-policy`](packages/dsh-plugin-content-policy) | **prevention** | Rules and structural stripping applied on the `tools/execute` waterfall, before the result is persisted. Rewrites the result **`value`**, so the rendered text *and* the persisted `meta` are cleaned together. |
| [`dsh-plugin-redact`](packages/dsh-plugin-redact) | **remediation** | In-place redaction and rollback of existing `session.vN.jsonl.zstd` logs, driven from inside `dsh-tui`. Includes a frame-level engine (also usable as the `dsh-redact` CLI), a live in-session `hide`, turn rollback, and undo. |

They are deliberately separate: prevention cannot help with what is already on disk, and remediation does nothing about the next search result.

```powershell
dsh plugin --profile <name> add ./packages/dsh-plugin-content-policy
dsh plugin --profile <name> add ./packages/dsh-plugin-redact
dsh --profile <name> --dump-config     # confirm both rows composed
```

`/redact pick` — the keyboard-selectable node list — is **off by default**: the modal dialog can lock the TUI keyboard when an approval panel is pending. See [`docs/01-platform/dsh-tui-internals.md`](docs/01-platform/dsh-tui-internals.md) for the mechanism, and the package README for the one-line opt-in.

## The research behind it

Everything in [`docs/reports/`](docs/reports) was established by reading the installed deployment and running it — not from documentation, which does not cover most of it. These are the raw artifacts, kept because the conclusions are only as good as the evidence:

| Path | What it is |
|---|---|
| `reports/redteam/` | Adversarial review of the redaction tool: ten findings with mechanisms, repro scripts, and the reader-as-oracle verdicts. Two of them made a session permanently unopenable while the tool reported success. |
| `reports/fix/` | The fixes, with before/after output captured per finding, plus the suite results |
| `reports/dialog-root-cause/` | Why a plugin dialog can lock the terminal keyboard: the exact three-part mechanism, a deadlock-state matrix, and standalone repro scripts |
| `reports/dialog-contract/` | The real `tuiDialogs` contract — validation bounds, promise semantics, the one throw path, and whether a renderer can be detected before opening a modal (it cannot) |
| `reports/boot-verify/` | Reproductions of the real `boot()` path: load/activation sweeps, config-boundary matrices, the dual-track `Config` comparison, and the measurement that shows `--dump-config` **does not import plugin modules at all** |
| `reports/surveys-existing-plugins.zh.md` | What already existed in the DSH plugin ecosystem before this was written, and where each near-miss stops short |

A synthesized set of platform notes (session-log format, persistence internals, the tool-result pipeline, the TUI's extension surfaces, a defect catalogue and a process retrospective) lives in the author's local Obsidian vault rather than here, because it is written against that vault's linking and metadata conventions.

## Verification status

| Suite | Assertions |
|---|---|
| `dsh-plugin-redact` handler | 248 |
| `dsh-plugin-redact` regression (real reader as oracle) | 54 |
| `dsh-plugin-redact` hardening | 78 |
| `dsh-plugin-redact` engine / CLI | 34 |
| `dsh-plugin-content-policy` (4 suites) | 103 |

The `dsh-plugin-redact` engine is additionally validated by opening its output with the **real** `JsonlSessionPersistence.open()`; a suite that only exercises the tool's own self-check is not accepted as evidence (that mistake shipped a defect — see the retrospective).

Requires **Node >= 22.15** for the zlib zstd API. The plugins themselves have no runtime dependencies — only optional peers.

### Reproducing these checks locally

```bash
cd packages/dsh-plugin-redact        && npm test   # engine 34 + handler 248 + torn-tail 11 + CLI smoke
cd packages/dsh-plugin-content-policy && npm test  # the two pure suites: 45 + 36
node .github/scripts/portability.selftest.mjs      # from the repo root
node .github/scripts/pack-check.mjs                # from the repo root
```

`.github/workflows/ci.yml` runs those same commands on `ubuntu-latest` and `windows-latest` across Node `22.15`, `22.x` and `24.x`. The suites that need a real DSH install are deliberately **not** in CI: they derive the install location from `DSH_HOME` and exit `3` when it is missing, rather than passing vacuously.

If you develop on Windows you can reproduce the Linux leg before pushing, instead of waiting for a red build. WSL is enough — no Docker needed:

```bash
curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz | tar -xJ -C /opt
/opt/node-v22.21.0-linux-x64/bin/node test/engine.selftest.mjs
```

#### Why there is a portability guard

The first CI run failed after 37 s: `test/preflight.mjs` read `process.env.USERPROFILE`, which is `undefined` on Linux, so `path.join(undefined, '.dsh')` threw `ERR_INVALID_ARG_TYPE`. That file is in the npm `files` allowlist, so **every non-Windows consumer running `npm test` would have hit it**. A test run on Windows alone cannot see this class of bug — it is invisible precisely where it is written.

`.github/scripts/portability.mjs` therefore statically scans the shipped code and tests of both packages for four Windows-only assumptions:

| Rule | What it catches |
|---|---|
| `win-only-env` | `USERPROFILE` / `HOMEDRIVE` / `APPDATA` / `LOCALAPPDATA` used without an immediately following `??` or `\|\|` fallback |
| `import-meta-pathname` | `import.meta.url` combined with `.pathname`, which leaves `%20` in paths containing spaces |
| `hardcoded-win-path` | A hard-coded drive letter in a string literal |
| `path-win32` | `path.win32`, which forces Windows semantics on every platform |

The rule for `win-only-env` is deliberately about *the variable*, not the line: `DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')` contains a `??` and is still broken.

Its self-test is the point of it. `portability.selftest.mjs` **injects the real `USERPROFILE` defect back into `preflight.mjs`**, asserts that the guard fails and names both the file and the correct line, then restores the file in a `finally`. A guard that cannot fail is worse than no guard, and a line number hard-coded into the test is a guard that goes red for the wrong reason.

#### Why there is a pack check

The `files` allowlist in each `package.json` is maintained by hand, and `index.js` imports `lib/engine.mjs` while `bin/dsh-redact.mjs` imports it a second time. Add an import and forget the allowlist entry, and every check here stays green while the published package is missing a file — a failure that only the consumer can see.

`.github/scripts/pack-check.mjs` asks npm what it would actually publish (`npm pack --dry-run --json`), then walks every relative import inside the shipped entry points and requires each resolved target to be in that tarball. It also asserts that nothing from a test run (`fixture.*`, `plan-*.json`, `needle.txt`, `broken.zstd`) rides along. Removing `lib/engine.mjs` from the allowlist makes it report both importers by name.

## License

MIT — see [`LICENSE`](LICENSE).
