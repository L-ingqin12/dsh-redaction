# `boot-verify/` — read this before copying anything

> [!WARNING]
> **`a/`, `b/` and `frozen/` contain snapshots of earlier revisions of the two packages. They are not the current code and must not be used as such.** Take code from [`../../../packages`](../../../packages).

The snapshots are kept as evidence, not as a distribution. They have drifted far enough that treating them as current would be actively harmful:

| Snapshot file | Lines | Current file | Lines | What the snapshot is missing |
|---|---|---|---|---|
| `frozen/dsh-plugin-redact/index.js` | 787 | `packages/dsh-plugin-redact/index.js` | 1192 | The fixes for two defects that could leave a session log **permanently unopenable** while the tool reported success |
| `frozen/dsh-plugin-redact/lib/engine.mjs` | 842 | `packages/dsh-plugin-redact/lib/engine.mjs` | 1218 | The same fixes at the engine layer, plus the torn-tail recovery and the pre-write reader replay |
| `frozen/dsh-plugin-redact/test/preflight.mjs` | 53 | `packages/dsh-plugin-redact/test/preflight.mjs` | 58 | `process.env.USERPROFILE`, which is `undefined` on Linux — the snapshot crashes there |

The two directories differ in what they were captured for:

- **`a/` and `b/`** — the two arms of a dual-track comparison, captured to show that the same config resolves identically on both tracks.
- **`frozen/`** — byte-frozen copies taken before a change, so a later measurement can prove what actually changed. This is why they are stale: that is their purpose.

Nothing imports or executes them. They are inert text on disk, kept because several conclusions in this project **overturned earlier ones**, and an audit trail that deletes its own "before" is not an audit trail.

## The rest of this directory

The other files here are working scripts, not snapshots, and they do run:

| File | What it does |
|---|---|
| `probe.mjs` | Boots the real `boot()` path for a candidate patch and reports the composed row list |
| `sweep*.mjs` / `stable.mjs` | Load/activation sweeps across variants; `sweep*.txt` and `stable.txt` are their captured output |
| `cfgmatrix.mjs`, `cfgtest.mjs` | The config-boundary matrix — which malformed config aborts the boot and which is tolerated |
| `cmp-branches.mjs` | Diffs two branches of the same config |
| `scan-fallback.mjs` | Confirms the model/route fallback ordering |
| `fix-*.mjs` | One-shot scripts that reproduced an individual boot-abort bug; each corresponds to a row in `../fix/` |

See [`../README.md`](../README.md) for the runtime requirements (Node >= 22.15, and a real DSH install for the boot probes). None of them read session content; every fixture is synthetic and built in a temp directory.
