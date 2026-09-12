# Verification artifacts

These are the raw outputs of the work that produced the packages in [`../../packages`](../../packages) — kept because a conclusion is only as good as the evidence behind it, and because several of the conclusions here **overturned earlier ones**.

| Directory | What it holds |
|---|---|
| `redteam/` | An adversarial review of the redaction tool with standalone repro scripts (`p1`–`p8`). Two findings made a session log permanently unopenable while the tool reported success. |
| `fix/` | The fixes, with `baseline/` and `after/` output captured per finding, plus the suite runs |
| `dialog-root-cause/` | Why a plugin dialog can lock the terminal keyboard — the three-part mechanism, a deadlock-state matrix, and repro scripts that drive the real dialog store without a TTY |
| `dialog-contract/` | The real `tuiDialogs` contract: validation bounds, promise semantics, the one throw path, and why a renderer cannot be detected before opening a modal |
| `boot-verify/` | Reproductions of the real `boot()` path: load/activation sweeps (`sweep*.txt`, `stable.txt`), the config-boundary matrix, the dual-track `Config` comparison, and the measurement that shows `--dump-config` never imports plugin modules |
| `surveys-existing-plugins.zh.md` | What already existed in the DSH plugin ecosystem, and where each near-miss stops short |

## Running these scripts

They were written against one machine and captured as-run. Absolute paths were replaced with the literal token `%USERPROFILE%` so no personal path is published.

Most of them now compute that path instead (`process.env.USERPROFILE`), so they run as-is. A few snapshots still contain the literal token — substitute your own path, or set the environment variable the script documents, before running.

Two constraints that will bite otherwise:

- **Node >= 22.15.** The zlib zstd API does not exist before that, so `require('node:zlib').zstdDecompressSync` is `undefined` and almost every script here fails in a misleading way. Use a 22.15+ interpreter explicitly (`node --version` first — a PATH `node` is often older).
- **A DSH installation.** Scripts that need the real reader or the real tool registry locate it from `DSH_HOME`, overridable with `DSH_NODE_MODULES` / `DSH_REDACT_DSH_LIB` depending on the script. When the installation is missing they exit non-zero rather than reporting a skip as success.

None of these scripts read session content; every fixture is synthetic and built in a temp directory.
