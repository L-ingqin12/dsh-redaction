# Security

## Reporting a vulnerability

Use a [private security advisory](https://github.com/L-ingqin12/dsh-redaction/security/advisories/new) rather than a public issue. There is no bounty and no support contract; expect an acknowledgement and an honest assessment, not a deadline.

If the report is that the tool **failed to remove something you needed removed**, that is the most serious class of bug in this project — please say so plainly. Do not include the content itself. Describe its shape instead (which tool, which field, which row), because nobody needs the payload in order to fix the parser, and a bug report is a permanent public record.

## What these tools do that a scanner will always flag

Both packages are small enough to read in one sitting. If you are looking at a static-analysis report, these categories are expected rather than overlooked:

| Finding | Why it is there |
|---|---|
| `fs.writeFileSync` against a session log | This is the product. `dsh-plugin-redact` rewrites rows inside `session.vN.jsonl.zstd`; a tool that scrubs a log without writing it does not exist. The target is the file the operator named, and the original bytes are copied to a sibling `<log>.quarantine-<ISO timestamp>` first — the test suite asserts that backup contains the original bytes. |
| `process.env.DSH_HOME`, `process.env.PATH`, `os.homedir()` | Locating the session directory and the `dsh` CLI. No value read from the environment is executed, and none is interpolated into a shell command. |
| `execFileSync(process.execPath, …)` | Two places only: the engine's own suite spawns the CLI to assert its exit codes, and a design prototype probes `dsh --dump-config`. The executable is the running Node binary rather than a resolved external path, and the `execFile` family never invokes a shell. There is no `shell: true` anywhere in either package. |
| `process.env.USERPROFILE` | Only inside the historical snapshots under `docs/` (see below). The shipped code uses `os.homedir()` precisely because that variable does not exist on Linux. |
| `eval` / `new Function` | Not present in either package. |

**There is no network capability anywhere in this repository** — not in the packages, not in the verification artifacts, not in CI. Verified by exhaustive search for `node:http(s)`, `node:net`, `node:dgram`, `node:tls`, `node:dns`, `fetch`, `XMLHttpRequest`, `WebSocket` and the usual client libraries. The tool cannot transmit what it removes, because it has no way to transmit anything.

## What these packages cannot do to you

Audited against the **published tarballs** (installed from the registry, not read from a working tree), because that is what you actually receive. Each row is a property of the shipped code, not a promise:

| Harm | Verdict | Why |
|---|---|---|
| Run code at install time | **No** | The only lifecycle script is `prepublishOnly`, which runs on the publisher's machine and never on yours. There is no `preinstall`/`install`/`postinstall`/`prepare`. |
| Kill your DSH process | **No** | The plugin imports exactly eight functions from the engine — `applyPlan`, `inspectBuffer`, `checkSeqDensity`, `scanFrames`, `decodeFrame`, `splitLines`, `loadLog`, `verifyLog` — all pure. It never imports or calls `main`, `runCli` or the CLI's `die`, and contains **zero** `process.exit`. The engine's four `process.exit` calls live on the offline CLI path, reachable only through `bin/dsh-redact.mjs`, which runs in its own process. |
| Break your boot by throwing on import | **No** | Every top-level statement in `index.js` is a declaration; nothing executes at import. Verified by importing both packages in an environment with no `DSH_HOME` at all. |
| Send anything anywhere | **No** | Neither package has any network capability — no `node:http(s)`, `net`, `tls`, `dgram`, `dns`, no `fetch`. A tool that cannot open a socket cannot exfiltrate what it removes. |
| Run an external command | **No** | No `child_process` import in either package, and no `shell: true` anywhere in the repository. |
| Execute dynamic code | **No** | No `eval`, no `new Function`, no dynamic `require`. |
| Delete files outside its own scope | **No** | Cache purging matches *exact* filenames (`<sessionId>.json` and its `.bak.` siblings) inside one fixed directory, and skips anything that is not a regular file. Log writes go to the path the operator named. |
| Lock your keyboard | **Not by default** | The modal `pick` dialog is off unless you set `allowDialogs: true` yourself; the shipped patch does not. |
| Change how your other tools behave | **Not by default** | `dsh-plugin-content-policy` ships `rules: []` and `strip: []`, which registers no listeners at all. It is inert until you configure it. |

### The one thing that can hurt you: this tool rewrites session logs

That is its function, so the realistic harm is self-inflicted data loss, and the write path is defended in depth rather than by a single check:

- The original bytes are copied to a sibling `<log>.quarantine-<ISO timestamp>` **before** anything is modified, and the suite asserts that backup contains the original bytes.
- The file's revision is compared **both before and after** the write handle is opened, so a concurrent append cannot be silently overwritten.
- The in-place path truncates to the target length *before* writing, so an interruption leaves only a prefix of the new content — a torn tail, which is exactly the case the reader tolerates and the engine can recover rows from.
- The size is re-checked after writing, and `fsync` runs before the handle closes. The replace path writes to a temp file, fsyncs it, then renames atomically and syncs the directory.
- If the target was never modified, the backup is **deleted** — so a failed operation does not leave an unlabelled copy of the original sitting in your session directory.
- If the target *was* modified, the error reports whether the backup survives and whether the log changed. Nothing is silent.

Two honest caveats. A hard kill (power loss, `SIGKILL`) during an in-place write can still leave a torn tail; the reader tolerates it and `dsh-redact verify` reports it, but the last row may be lost. And writes require an explicit commit — every destructive path defaults to a dry run.

## Supply chain

The realistic way to harm *users of these packages* is not the code, it is the publishing credential. A token that can publish can ship a malicious version to everyone.

If you publish these packages, prefer a **granular access token scoped to these two packages** over an account-wide one, keep it out of shell history and dotfiles where possible, and treat npm's own 2FA prompt as the safer default over a token with 2FA bypass. A leaked publish token is a supply-chain incident, not just an account problem.

## What actually reaches you

The npm tarballs contain only the `files` allowlist in each `package.json`: **13 files** for `dsh-plugin-redact`, **9** for `dsh-plugin-content-policy`. Nothing under `docs/` is published, and no test fixture ever is. `.github/scripts/pack-check.mjs` asserts this on every push, along with the fact that every relative import reachable from the entry points resolves to a file inside the tarball.

The test suites ship on purpose. `npm test` inside an installed copy is evidence you can reproduce against the bytes you actually received, which matters more than usual for a tool that rewrites session logs.

## Historical snapshots under `docs/`

`docs/reports/` keeps the raw evidence behind the packages, including **snapshots of earlier revisions** under `docs/reports/boot-verify/{a,b,frozen}/`. Two consequences:

- **They are not the tools.** `frozen/dsh-plugin-redact/index.js` is 787 lines where the current file is 1192 — it predates the fixes for defects that could leave a session log permanently unopenable while the tool reported success. Do not copy code out of these directories; take it from `packages/`.
- Static analysis reports on them at the same severity as live code, and a reader skimming the tree can mistake them for the real thing.

They are kept anyway, because several of this project's conclusions **overturned earlier ones**, and an audit trail that deletes its own "before" is not an audit trail. The directory README repeats this warning where you will actually see it.

## Supported versions

Both packages require **Node >= 22.15** for the zlib zstd API. Earlier runtimes fail loudly with an explicit version error rather than corrupting a log — but do not rely on that being the only symptom; run 22.15 or newer.

Only the latest published version of each package is supported. Both are pre-1.0, and the format they operate on (`session.v3.jsonl.zstd`) is versioned by DSH itself, so a future DSH release can invalidate the current engine. The engine refuses logs it does not recognise rather than guessing.
