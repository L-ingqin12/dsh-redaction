# dsh-plugin-redact

**In-place redaction and row-level rollback for DSH session logs (`session.vN.jsonl.zstd`), usable from inside `dsh-tui`.**

No new session, no deleting the whole conversation, no moving the log around: it rewrites the exact bytes in the original file and leaves the log readable by the DSH reader.

| | |
|---|---|
| Package | `dsh-plugin-redact` |
| Version | 0.1.0 |
| License | MIT |
| Runtime | Node.js **>= 22.15.0** (uses `zlib.zstdCompressSync` / `zstdDecompressSync`) |
| In-TUI command | `/redact list\|nodes\|scan\|hide\|plan\|apply\|verify\|purge\|rollback\|undo` |
| Offline CLI | `dsh-redact inspect\|paths\|verify\|plan\|apply\|cut\|graph` |
| Hard dependency | Consumes the host `commands` service only (`inject: ['commands']`); publishes no service |

---

## 0. What problem it solves

Once a tool result, command output, or fetched page enters a session, a persistence batch writes it into `session.vN.jsonl.zstd`, where it then **sits on disk indefinitely** — replayed in later history, fed back into later context, indexed or exported. The content need not be a "secret": it may be material you are not allowed to retain, a credential, or simply **wrong or outdated information that should stop influencing later decisions**. You decide the criterion; this tool only guarantees that the bytes already on disk are removed or rewritten — **without corrupting the log**.

It does two things: **rewrite** (replace matched text/fields in place, or blank a whole line) and **cut** (drop trailing rows, or middle rows with an explicit renumber pass). Afterwards the session still opens, replays, and appends normally.

Keep four different outcomes apart, because four subcommands own them:

* **`/redact hide`** — **immediately** removes matching tool results from the **current session's model view** by appending `surfaceOp: {op:'replace'}` replacement nodes. The model stops seeing them from the next request, **with no restart**. **Disk bytes are unchanged.** It locates its targets three ways: a `find` in `plan.json`, an index from `/redact nodes`, or a log line number (see §3.1).
* **`/redact apply`** — actually **rewrites the log bytes on disk** (in place, same row count). It requires the session not to be in use (otherwise an explicit `--allow-live`), so it is best run through the offline CLI while the session is closed.
* **`/redact rollback <turns>`** — **retracts conversation that already happened**: truncates the last N complete turns at a `turn/end` boundary. This is a suffix drop, the safest kind of deletion.
* **`/redact undo`** — **reverts your own redaction**: restores from the newest quarantine backup.

They are complementary: `hide` to stop the bleeding (content stops entering later context) → `apply` once the session is closed to remove the bytes → `undo` if you regret it. **With `hide` alone the original stays on disk in full.**

---

## 1. ⚠️ Read this first: **deleting a middle row makes the whole log unreadable**

> [!WARNING]
> The DSH reader has one non-negotiable invariant: **every row's `seq` must equal its row index** (0-based; row 1 is the header and is exempt). The decoder asserts `event.seq === eventCount` row by row.
>
> Therefore **deleting any middle row makes the reader reject the entire log as corrupt** — you do not lose one row, you lose the session.
>
> In-place rewriting, by contrast, is safe: row count, row order, `type`, `seq`, `time`, and all cross-references stay identical, so it is completely transparent to the reader.

So the primary mechanism is **three kinds of in-place rewrite**; deletion is a supplement:

| Operation | What it does | Structural effect | When to use it |
|---|---|---|---|
| `substitutions` | Replace a matching substring inside every string value (can be narrowed with `path` / `lines`) | None: row count / `seq` / `type` unchanged | The same text is scattered across many rows (tool results, `meta`, echoed arguments) and you want it gone everywhere at once |
| `setFields` | Replace the value at one JSON path **on one row** | None | You have located the exact spot with `paths` and want only that one field changed |
| `blankLines` | Replace **every string value** on those rows with the placeholder (default `[已移除]`) | None: `type` / `seq` / `time` / `id` untouched | The whole row's content is void, but the row itself must stay (event counts, turn structure, tool-call pairing) |
| `dropLines` | **Delete** those rows | ⚠️ Yes: row indices shift | Safe only for a **trailing suffix** (references always point backwards). A middle drop requires `renumber: true` |
| `renumber` | Permit middle deletion: renumber every `seq` and remap all backward references | ⚠️ Large | You genuinely need the row to not exist and accept rewritten `seq`s. A **dangling reference** (some row references a deleted row) is still refused |

Prefer the first three when you only need the content gone; reach for `dropLines` only when the row itself must disappear.

---

## 2. Install

Two ways. **A** is the normal one (the package declares `dsh.bundle`, so it becomes a profile layer); **B** is for a hand-written row.

### 2.1 A: as a bundle (recommended)

```sh
# from a local directory (relative specs are anchored to the invoking directory first)
dsh plugin --profile <name> add ./dsh-plugin-redact

# or from npm / git
dsh plugin --profile <name> add dsh-plugin-redact
dsh plugin --profile <name> add github:<you>/dsh-plugin-redact#<commit>
```

`dsh plugin --profile <name> <args...>` ensures the profile exists, then **forwards the arguments to pnpm** with the profile directory as the working directory — so `add` / `remove` / `why` / `update` all work, and `pnpm` must be on `PATH`. Because the package declares

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

a successful install adds it to that profile's `dsh.profile.bundles` and applies its `cordis.patch.yml` as a layer (a single `- insert:` row with `id: dsh-redact`).

### 2.2 B: as a plain profile row

Edit `<DSH_HOME>/profiles/<name>/cordis.patch.yml` (this is the user layer; the neighbouring `cordis.yml` is a generated empty root — do not edit it):

```yaml
# top-level YAML array; an insert with no id appends top-level rows
- insert:
    - id: dsh-redact
      name: dsh-plugin-redact          # bare name: resolved from <profile>/node_modules
      config:
        root: !!js dshHomePath('sessions')
        cacheRoot: !!js dshHomePath('storages')
        placeholder: '[已移除]'
```

Two resolution rules that matter:

* **The package must be resolvable from the profile's `node_modules`.** A bare name is looked up by Node starting at the **profile directory** ( `<profile>/node_modules`, `<DSH_HOME>/profiles/node_modules`, …), so either run `dsh plugin --profile <name> add ./dsh-plugin-redact` first, or install the package into the profile's dependencies. **Leaving the package in some unrelated directory and referencing it by name will not resolve.**
* **On Windows an absolute local path must be a `file://` URL.** The loader uses dynamic `import()`; a raw `C:\...\index.js` is parsed as the URL scheme `c:` and fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Generate it with `pathToFileURL`, and point at the **entry file** (a directory fails with `ERR_UNSUPPORTED_DIR_IMPORT`):

  ```sh
  node -p "require('node:url').pathToFileURL('C:/Users/me/dsh-plugin-redact/index.js').href"
  # => file:///C:/Users/me/dsh-plugin-redact/index.js
  ```

  A relative path (`./dsh-plugin-redact/index.js`) also works; it resolves relative to the **including file** (the profile directory).

### 2.3 Config

| Field | Default | Meaning |
|---|---|---|
| `root` | `<DSH_HOME>/sessions` | Session-log root; layout is `<root>/<project-key>/<session-id>/session.vN.jsonl.zstd` |
| `cacheRoot` | `<DSH_HOME>/storages` | Derived-cache root; `purge` deletes only here |
| `placeholder` | `[已移除]` | Text written by `blankLines` (`substitutions`' `replace` defaults to the empty string, i.e. plain deletion) |

`<DSH_HOME>` falls back to `~/.dsh`. The shipped `cordis.patch.yml` uses the deployment's own `!!js dshHomePath(...)` helper, exactly like the official `session-persistence-jsonl` row, so it follows `DSH_HOME`.

### 2.4 Confirm it mounted

```sh
dsh --profile <name> --dump-config     # prints the composed config without booting
```

The output should contain the `id: dsh-redact` row, annotated with the layer it came from. *(This command also rewrites the profile's generated empty `cordis.yml` and may heal `profiles/node_modules` links; both are idempotent.)*

In a `patchReload: live` profile, editing `cordis.patch.yml` takes effect without a restart, and the new command enters the TUI's `/` menu live via `commands/change`. **Editing the contents of an already-imported module is not hot** — restart or rename the file. Creating the plugin file for the first time needs no restart.

---

## 3. Usage

### 3.1 `/redact` subcommands

`/redact` addresses sessions by **session id** (`--session <id>`), not by log path; without `--session` the target is **the current session**. Its argument hint in the `/` menu is `[list|nodes|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]`.

| Subcommand | Syntax | Output / behaviour |
|---|---|---|
| `list` | `/redact list` | Sessions by descending size, **folded into one line**: `共 N 个会话（按体积）：` + segments of `<first 8 chars of id> <size>` (human-readable, e.g. `1.5MB` / `805.4KB` / `551B`) joined by ` ｜ `, with `(当前)` appended to the current session's segment; the budget is 200 display cells, so trailing entries collapse into ` …另M个`, and the line always ends with ` 用 /redact nodes 看当前会话`. This is also the default when no subcommand is given |
| `scan` | `/redact scan <plan.json> [--session <id>]` | **Locate only**: `会话 <id>：共 N 行，命中 M 行` plus hit line numbers (12 max, then `…（共 M）`), or `未命中任何内容`; always ends with `（只定位，未改动任何文件）`. The count includes the header row. ⚠️ It uses only `substitutions[].find` as probes — a plan containing only `setFields`/`blankLines` cannot be located and reports no hits; it honours `substitutions[].lines`: only hits inside the restricted range are reported, and the output says `（已有 substitutions[].lines 限定，此处只报限定区间内的命中，与 apply 语义一致）` — the same semantics as `apply` |
| `nodes` | `/redact nodes` | Lists the **current session's** `tool/result` surface nodes, **newest first**, one segment each as `[index] line tool size` (e.g. `[1] 7 web_fetch 123B`) joined by ` ｜ `: `共 N 个 tool/result（最新在前）：[1] … ｜ [2] … 隐藏用 /redact hide <序号>`. The tool name is resolved by looking the result's `message.source.callId` back up in the `tool/call` events (unresolved shows `(未知工具)`); sizes ≥1KB render as `12.3KB`. The budget is 200 display cells, so overflow becomes ` …另N个`. **Line numbers and sizes only — never the body**; the listing is remembered per session and is what `/redact hide <序号>` refers to |
| `hide` | `/redact hide <index\|plan.json> [--commit]`, `/redact hide --lines <line> [--commit]` | **Current session only**, three ways to locate targets (see below): ① `<index>` refers to entry N of the **most recent `/redact nodes`**; ② `<plan.json>` finds the `tool/result` **surface nodes** whose `data.message` contains any `substitutions[].find`; ③ `--lines <line>` targets by log line number (exactly the number `nodes` printed). Without `--commit` it only dry-runs (`试算：将隐藏 N 个节点（seq 5）· 加 --commit 执行`, or `试算：未命中任何 tool/result 节点`; nothing appended, nothing on disk touched); with `--commit` it appends one replacement node per target and reports `已隐藏 N 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）` (or `未命中任何 tool/result 节点，未做改动` when nothing matched). **Disk bytes unchanged**; effective from the next request |
| `plan` | `/redact plan <plan.json> [--session <id>]` | **Dry run, writes nothing**: `试算通过（未写任何文件）` plus byte delta, frame/row stats, and `自检：JSON 可解析、头部合法、seq 密集` |
| `apply` | `/redact apply <plan.json> [--session <id>] [--allow-live]` | **Rewrites in place**: records the file revision → reads it → plans → re-checks the revision (any append in between refuses the whole run) → writes the quarantine backup → commits → purges derived caches, then lists the locations it will not touch. Under `--allow-live` a **torn tail** causes a refusal (the write handle caches a truncation offset computed for the pre-rewrite layout, which risks silent corruption) |
| `verify` | `/redact verify [--session <id>]` | `会话 <id>（v<version>）` + `帧 N / 行 N / 解析失败 N / 头部合法 是\|否` + `seq 密集性：通过` + `结论：读取端可正常打开`; a damaged frame header yields `日志无法解析：<reason>` instead of an exception |
| `purge` | `/redact purge [--session <id>]` | Deletes that session's derived cache files (each listed), then lists the locations **this tool will not modify** |
| `rollback` | `/redact rollback <turns> [--session <id>] [--commit]` | **Turn-based rollback**: counts the `turn/end` boundaries and truncates the last N complete turns (1 turn when the count is omitted). Dry run by default (`会话 <id>：共 T 个完整轮次` + `回退 N 轮 → 保留 K 轮，从第 L 行起截断（共 D 行会被删除）`); `--commit` writes. At least one turn must remain; a log with no `turn/end` is refused outright |
| `undo` | `/redact undo [--session <id>] [--commit]` | **Reverts the last redaction**: finds the **newest** quarantine backup for that log and dry-runs by default (how many backups, the newest one's name/size/time, current log size); `--commit` restores it, first saving the **current** state as `<log>.before-undo-<timestamp>`, then purges derived caches |

#### Why every output is a single line (the rendering constraint)

dsh-tui **never** shows a command's returned `text` directly: it runs `cleanRenderText(text, COMMAND_RESULT_CELLS)` first, where `COMMAND_RESULT_CELLS = 200` (inside `@deepseek-harness-tui/dsh-tui`: the constant is at `lib/types/screens/Chat.js:120`, the call site in the same file at `:1082`), implemented in `lib/types/dsh-adapter/sanitize.js`:

```js
const flat = withoutAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
if (stringWidth(flat) <= maxCells)
    return flat;
let out = '';
for (const ch of flat) {
    if (stringWidth(out + ch) > maxCells - 1)
        break;
    out += ch;
}
return `${out}…`;
```

Two things happen at once, and neither can be worked around:

1. **All whitespace is flattened**: `\n`, `\t`, and runs of spaces all become a single space — **multi-line output becomes one line here, always**.
2. **It is truncated at 200 display cells** with a trailing `…`. Width is measured in terminal cells, and **a CJK character counts as 2**, so a Chinese notification really only has room for ~100 characters.

So use this tool on that assumption:

* **Do not expect readable multi-line formatting.** Anything past 200 cells is cut off, tail first.
* **Do not plan around copying a long string out of a notification.** The notification has been flattened and truncated; a long path or line number may already be gone and is awkward to select anyway. This is exactly why `hide <index>` exists: after `/redact nodes`, hiding the newest entry is just `/redact hide 1 --commit` — **not one character copied from a notification**.
* `list` / `nodes` / `hide` are therefore **deliberately formatted as one short line, most important information first**: they would rather show fewer entries (`…另N个`) than let a critical line number or index be truncated away.
* `verify` / `plan` / `apply` / `purge` / `rollback` / `undo`, plus usage and error text, still return a genuinely multi-line string from the handler (the newlines are there) — but the renderer collapses that into one line too and truncates it at 200 cells, which is why each of them leads with its most important conclusion.

Details, all taken from the implementation:

* **`rollback` and `undo` are dry runs by default** — they need an explicit `--commit` to write, as does `hide`. `rollback` / `undo`, like `apply`, **refuse to act on the session you are currently using** unless `--allow-live` is given; `hide` is the exact opposite — **it only acts on the current session**, errors out when `--session` points elsewhere, and does not accept `--allow-live` at all.

* **`nodes` exists to feed `hide <index>`.** It lists the **current session's** `tool/result` surface nodes, **newest first** (the one that just tripped a guardrail is almost always the latest), one segment per node as `[index] line tool size`, resolving each tool name by looking the result's `message.source.callId` back up in the `tool/call` events. The whole output is one line inside a 200-cell budget. It **never shows the body**, and it does not expose the internal `seq` (`seq` only appears in `hide`'s dry-run result).

* **Put the match text in `plan.json`, never on the command line.** The command registers with `recordInput: false`, so `rawInput` never enters the session log — but the frontend's own input history (`~/.dsh-tui/history.jsonl`) does not honour that flag, so anything you type may still persist there.
* `--session <id>` is a **session id**. If a session has both `session.v2.jsonl.zstd` and `session.v3.jsonl.zstd`, only the **highest version** is targeted.
* Resolution walks `<root>/<project>/<id>/` and picks the highest `session.vN.jsonl.zstd`; on failure: `找不到会话 <id> 的日志`.
* Arguments are split on `"..."` / `'...'` / whitespace, and **outer quotes are stripped** — so a path containing spaces just needs quoting (`/redact apply "C:\my plans\plan.json"`). Relative paths still resolve against the host process's cwd, so absolute paths are recommended.
* `hide` handles **`tool/result` nodes only** (user and assistant messages are skipped), and the replacement text is always the configured `placeholder`, so **a plan's `replace` has no effect on `hide`**. It locates targets three ways:
  * `<index>` — entry N of **this session's most recent `/redact nodes`**, where `1` is the newest. That listing lives in memory only and is kept per session: running `hide 1` before any `nodes` reports `还没有节点列表，请先运行 /redact nodes`, an out-of-range index reports `序号 99 超出范围（当前 1-2）`, and it is lost when the host process restarts.
  * `<plan.json>` — a substring test over the serialised `data.message`, using only `substitutions[].find` (every other key is ignored).
  * `--lines <line>` — by **log line number**, i.e. exactly the number `nodes` printed (row 1 is the header, so an event with `seq` N is row N + 2). It accepts a line spec: `--lines 7`, `--lines 3-5`, `--lines 3,5-7`. This form **needs no plan.json at all**, so not one character of the original has to land in a file.
  * With none of the three it reports `用法：/redact hide <序号|plan.json> 或 /redact hide --lines <行号>`; `--lines` must carry a value (`--lines --commit` is parsed as a bare flag, i.e. as if it were absent). Pointing `--session` at another session reports `hide 只作用于当前会话；其它会话请用 /redact apply 重写日志。`
* `--allow-live` must be a **bare flag**. `--allow-live yes` stores the string `'yes'`, fails the `=== true` check, and is still refused.
* An unknown subcommand returns `未知子命令 <cmd>` plus usage; with neither an `agent` nor `--session` you get `无法确定目标会话，请加 --session <id>`.

### 3.2 The full `plan.json` schema

The same plan file works for the in-TUI `/redact` and the offline `dsh-redact`.

| Key | Type | Meaning |
|---|---|---|
| `substitutions` | `[{ find, replace?, path?, lines? }]` | `find` must be a non-empty string. `replace` omitted means `''`, i.e. **delete the text**. `path` is a dot-path prefix limiting which strings are touched; `lines` limits the row range. All string values are walked recursively, but **protected keys are skipped** |
| `setFields` | `[{ line, path, value }]` | `line` is a 1-based logical row number (never 1); `path` must already exist, otherwise `第 N 行上找不到路径 ...`; `value` may be any JSON value |
| `blankLines` | line spec, e.g. `"830-834"` | Replaces **every string value** on those rows with the placeholder (from `placeholder` in the TUI path; default `[已移除]`) |
| `dropLines` | line spec | Deletes those rows. A **trailing suffix** is allowed directly; a **middle** drop requires `renumber: true` and is otherwise refused |
| `renumber` | `true` / omitted | Permits middle deletion: renumbers `seq` and remaps `surfaceOp.startSeq/endSeq`, `sourceEventSeqs`, `data.shadowedSeqs`, `data.shadowedRange`. A reference to a deleted row is **refused**, with advice to use `blankLines` |
| `keepTorn` | `true` / omitted | Defaults to `false`: a **torn** (partially written) trailing frame is dropped on rewrite — `inspect` reports whether one exists under "尾部残帧起点". `true` keeps those bytes verbatim |

Line spec format: `"812"`, `"812-830"`, `"812,900,1024-1100"` (comma-separated, ranges allowed). Line numbers are **1-based logical JSONL rows, where row 1 is the header**.

**Protected keys** (skipped by `substitutions`, refused by `setFields`): `type`, `seq`, `time`, `surfaceOp`, `sourceEventSeqs`, `toolCallId`, `callId`, `role`, `id`. They carry structure, ordering, and cross-references.

**Row 1 (the header) can never be dropped, blanked, or rewritten.**

> [!WARNING]
> **Unknown or misspelled keys are silently ignored** — the engine reads only the keys above. A typo like `"substitions"` raises no error and does nothing, while looking like success. **Always dry-run before applying, and always verify afterwards.**

`/redact hide <plan.json>` uses only `substitutions[].find` and ignores every other key, so one plan can serve both `hide` and `apply`; `hide --lines <line>` and `hide <index>` do not need a plan file at all.

### 3.3 A worked `plan.json`

> Everything below is **placeholder text**. In real use, `find` is the text you want gone — and that file is itself sensitive; delete it when you are done.

```json
{
  "substitutions": [
    { "find": "PLACEHOLDER-SECRET-VALUE", "replace": "[已移除]" }
  ],
  "setFields": [
    { "line": 812, "path": "data.message.content.0.text", "value": "[已移除]" }
  ],
  "blankLines": "830-834"
}
```

How to fill it in:

1. Find the hit rows with `dsh-redact inspect <log> --match-file needle.txt` — put the text in `needle.txt`, **not on the command line**; `inspect` prints line numbers only and never echoes the text.
2. Inspect the row's JSON shape with `dsh-redact paths <log> --line 812` — it lists **paths and types only** (`data.message.content.0.text  =  string(len=26)`), no values. Copy a path into `setFields[].path`.
3. Blank whole rows with `blankLines`, target one field with `setFields`, or sweep text everywhere with `substitutions`.

### 3.4 Offline CLI

When the session is **not running**, the offline CLI is the easier path (the `.mjs` also runs as `node lib/engine.mjs <subcommand>`; the registered binary name is `dsh-redact`). It takes a **log file path**, not a session id.

| Subcommand | Syntax | Meaning |
|---|---|---|
| `inspect` | `dsh-redact inspect <log> [--frames] [--match-file <f> \| --match <s>]` | Structure stats: file, byte size, complete frames, torn-tail offset, logical rows, frames without checksums; `--frames` adds a per-frame table (index, byte range, plain bytes, rows, logical row range); `--match-file` / `--match` add hit count, hit line numbers, and the frames involved. Line numbers and counts only |
| `paths` | `dsh-redact paths <log> --line <n> [--no-keys]` | Prints that row's JSON structure (path + type + length), never values; `--no-keys` hides object key names |
| `verify` | `dsh-redact verify <log>` | Structure + `seq` density self-check. **Exit code 0 = healthy, 2 = problem** |
| `plan` | `dsh-redact plan <log> --plan <plan.json>` | Dry run, writes nothing |
| `apply` | `dsh-redact apply <log> --plan <plan.json> [--out <f>] [--apply]` | Writes the result to `<log>.new` by default (**original untouched**); `--apply` writes a quarantine backup and replaces in place |
| `cut` | `dsh-redact cut <log> --drop <spec> [--renumber] [--apply]` | Shorthand for dropping rows. ⚠️ A middle drop without `--renumber` fails immediately |
| `graph` | `dsh-redact graph <sessionsRoot>` | Recursively scans every `session*.jsonl.zstd` under the root, decodes only the header frame, and prints id / parent / seeded / origin / depth / file — see the session lineage so forked copies are not missed |

One example each:

```sh
# 1) structure + hit location (never prints text)
dsh-redact inspect "$LOG" --frames
dsh-redact inspect "$LOG" --match-file ./needle.txt

# 2) see what a row exposes
dsh-redact paths "$LOG" --line 812

# 3) structural self-check (do not touch a log that fails it)
dsh-redact verify "$LOG"

# 4) dry run: statistics only, nothing written
dsh-redact plan "$LOG" --plan ./plan.json

# 5) execute: produce <log>.new for inspection first, then replace in place (backup first)
dsh-redact apply "$LOG" --plan ./plan.json
dsh-redact apply "$LOG" --plan ./plan.json --apply

# 6) drop rows: a middle drop needs explicit renumbering
dsh-redact cut "$LOG" --drop 812
dsh-redact cut "$LOG" --drop 812 --renumber --apply

# 7) session lineage
dsh-redact graph "$DSH_HOME/sessions"
```

The execution statistics for `plan` / `apply` / `cut` look like this (fields explained in §1 and §3.2):

```
试算结果（未写任何文件）
字节 原 / 新   : 532 / 539
保留帧(原字节) : 1
重写帧 / 移除帧: 3 / 0
删除行 / 清空行: 0 / 1
路径改写 / 替换: 1 / 2
重编号行数     : 0
自检           : 通过（JSON 全部可解析、头部合法、seq 密集）
```

**Untouched frames are preserved byte-for-byte** (not even recompressed); only modified frames are recompressed, and they carry a zstd checksum.

> [!WARNING]
> The offline CLI differs from the in-TUI command in two ways:
> 1. It **cannot know whether the session is running**, so there is no `--allow-live` gate — make sure the session is closed yourself.
> 2. It **does not purge derived caches** (that is `/redact apply` and `/redact purge`). Run `/redact purge --session <id>` afterwards, or delete the cache files listed in §4 by hand.

### 3.5 Two recommended flows

**Session not running (safest, preferred)**

```sh
dsh-redact verify "$LOG"                          # 1. confirm the file is healthy
dsh-redact inspect "$LOG" --match-file needle.txt # 2. locate hits
dsh-redact plan "$LOG" --plan plan.json           # 3. offline dry run
dsh-redact apply "$LOG" --plan plan.json          # 4. write .new, inspect it
dsh-redact apply "$LOG" --plan plan.json --apply  # 5. replace in place (backup first)
dsh-redact verify "$LOG"                          # 6. re-verify
# 7. delete the quarantine backup (it still holds the original), then clear the caches
```

**Session running (inside the TUI)**

```
/redact list                                      # 1. find the target session id
/redact scan  C:\plans\plan.json --session <id>   # 2. locate only, nothing written
/redact plan  C:\plans\plan.json --session <id>   # 3. dry run
/redact nodes                                     # 4. current session's tool/result list (newest first: index line tool size)
/redact hide 1                                    # 5. dry-run hiding entry 1 (the newest) — 4 tokens, nothing to copy
/redact hide 1 --commit                           # 6. take it out of model view (next request, no restart)
/redact hide --lines 7 --commit                   #    or by log line number (7 is the number nodes printed)
/redact hide  C:\plans\plan.json --commit         #    or by the find in plan.json (dry-run first, then --commit)
/redact apply C:\plans\plan.json --session <id>   # 7. a session nobody is using: rewrite the bytes
/redact verify --session <id>                     # 8. re-verify
/redact purge  --session <id>                     # 9. purge caches (apply already did once)
/redact undo   --session <id>                     # 10. regret it: dry-run, then --commit to restore the backup
```

Steps 4–6 are **designed around the flattened notification**: `nodes` squeezes the index, line number, tool name, and size into one line, and `hide <index>` needs nothing but a digit to point at a node (see the rendering constraint in §3.1).

Note the division of labour: **`apply` on the current session is always refused** (see §4), so "the session I am sitting in" takes two steps — `hide --commit` first to stop the model seeing it right now (bytes still on disk), then the offline CLI once the session is closed (or `--allow-live` plus a restart) to remove the bytes. Conversely `hide` only accepts the current session: for any other session, go straight to `apply`. And if what you want to revoke is **whole turns** rather than a piece of text, use `rollback <turns>`; if it is **your own last redaction**, use `undo`.

---

## 4. Safety model

| Gate | Concrete behaviour |
|---|---|
| **Never prints content** | `/redact` and the CLI emit **line numbers and counts only**. `inspect --match` reports hit rows; `paths` reports paths, types, and lengths; even JSON parse errors are sanitised (keeping only `position N` and stripping the input snippet Node attaches) so an error message cannot leak the original text into the terminal or a log |
| **Quarantine backup before any in-place replacement** | In the TUI: `<log>.quarantine-<timestamp>` (ISO time with `:` and `.` replaced by `-`); same for CLI `--apply`. **The backup still contains the original** — delete it yourself once satisfied; the tool never does |
| **How it commits** | **Idle session**: write the quarantine backup → write `<log>.redact-tmp` → `rename` over the log. **Live session (`--allow-live`)**: write the quarantine backup → `open('r+')` → write → `ftruncate` → `fsync`, an **in-place overwrite** — a rename could collide with an appending handle (especially on Windows), whereas the backend re-opens with `open(path,'a')` and writes at EOF for every batch, so an overwrite does not conflict with it |
| **Concurrent-append detection** | `apply` and `rollback` record the file revision (`size:mtimeMs:ctimeMs`) before reading and re-check it before committing; if the log was appended to in between, the whole run is **refused** (`未执行：日志在本次读取之后被追加过（可能有并发写入）`) rather than overwriting new events |
| **An extra gate under `--allow-live`** | For a live session, a **torn tail** causes an outright refusal: the write handle caches a "truncation offset computed for the pre-rewrite layout" and the next append would truncate by it, risking **silent corruption**. Close the session and retry |
| **`rollback` boundary protection** | Truncation happens only at a complete `turn/end` boundary, at least one turn must remain (a log with no `turn/end` is refused), and a cut that would remove an inherited `session/end-seed` marker (which the reader treats as corruption) is refused too |
| **`undo` never clobbers** | Before restoring, the **current** state is saved aside as `<log>.before-undo-<timestamp>` and only then is the newest quarantine backup copied back — both ends keep a copy, so the undo itself is traceable |
| **Refuses the live session** | If the target is the current session and `--allow-live` is absent, `apply` / `rollback` / `undo` all error out: the write handle still holds that log, so an in-place replacement could break subsequent appends. The message gives the safe alternative and notes that `--allow-live` requires reopening the session to reload history |
| **Self-check before writing** | Before output is produced it re-validates: all JSON parses, the header is legal, **`seq` is dense**. Any failure aborts the output (`内部自检失败，已放弃输出`) — nothing is written rather than something broken |
| **Header and structural keys protected** | Row 1 can never be dropped, blanked, or rewritten; `type`/`seq`/`time`/`surfaceOp`/`sourceEventSeqs`/`toolCallId`/`callId`/`role`/`id` are never touched by `substitutions` or `blankLines`, and `setFields` refuses to write them |

### Derived-cache purge (`purge`, and part of `apply`)

`/redact purge --session <id>` (and the end of `/redact apply`) deletes:

* `<cacheRoot>/session_projcache/sessions/<id>.json`
* `<cacheRoot>/session_projcache/sessions/<id>.json.bak.*`

### Locations this tool deliberately does **not** touch

`purge` **lists these paths** (paths only — it never reads their content) but will not modify them:

* `<DSH_HOME>/storages/session_projcache.json` — the legacy **aggregate** cache; deleting only the per-session cache can let content flow back from it, so delete it too.
* `~/.dsh-tui/history.jsonl` — frontend input history.
* `~/.dsh-tui/session-index.json` — frontend session index.
* `%TEMP%/dsh-spill-*`, `%TEMP%/dsh-subprocess-*` (`$TMPDIR` on POSIX) — spill and subprocess temp files.

Beyond that, **any copy that has left the machine is out of scope**: files written, exported reports, uploads, requests already sent to a provider — see §6.

---

## 5. Verification: proving the redaction worked

Three checks, from "the structure is intact" to "the content is really gone":

**1) In the TUI**

```
/redact verify --session <id>
```

```
会话 <id>（v3）
帧 3 / 行 6 / 解析失败 0 / 头部合法 是
seq 密集性：通过
结论：读取端可正常打开
```

(That is the handler's raw return value; the notification flattens it to `会话 <id>（v3） 帧 3 / 行 6 / 解析失败 0 / 头部合法 是 seq 密集性：通过 结论：读取端可正常打开`. See the rendering constraint in §3.1.)

**2) Offline**

```sh
dsh-redact verify "$LOG"
```

Fields: file, complete frames, frames with checksums, torn-tail offset, total rows, JSON parse failures, `seq` density, header validity, conclusion. **Exit code 0 = self-consistent, 2 = problem**, so it scripts cleanly.

**3) Content level**

Re-scan with `inspect --match-file needle.txt`: the hit count should now be `0`. It prints line numbers only, so the re-check does not re-expose the text.

### What "seq density" means

The session log is a plain concatenation of **independently checksummed Zstandard frames**: frame 0 holds a single header row (`{"type":"session",...}`), and every later frame is one persistence append batch containing 1..N JSONL event rows, one event per row.

**Dense `seq`** means: for every row except row 1 (the header), its `seq` equals `row index - 1` (0-based). This is the reader's hardest invariant — it accumulates `eventCount` row by row and asserts `event.seq === eventCount`, rejecting the whole log as corrupt at the first gap.

`seq 密集性：通过` therefore means "this invariant holds and the reader can open the log". It does **not** prove the content is gone — confirm that with the step-3 hit re-scan.

### The self-tests in the repository

Four scripts, all using **synthetic logs only** (fake content; no real session is touched), covering different layers:

| Script | Assertions | Coverage |
|---|---|---|
| `test/handler.selftest.mjs` | 159 (the script prints its own `N/M 通过`) | **Plugin handler layer**: command registration metadata; the output and side effects of `list`/`scan`/`hide`/`plan`/`apply`/`verify`/`purge`; `--session` and `--allow-live`; every error path; `list`'s **single line inside the 200-cell budget** (including the `(当前)` marker, `…另N个`, and human-readable sizes); `hide` dry-run and `--commit` (asserting the `将隐藏 N 个节点` dry-run wording, the `surfaceOp`/`sourceEventSeqs` shape, that the body now carries the placeholder, and that **no disk bytes are deleted**); nested `blankLines`; cross-frame global substitution; suffix drops; middle drops; `renumber` reference remapping and dangling-reference refusal (asserting that a **`RedactError` is thrown**); header-frame byte preservation |
| `test/bugfix-regression.mjs` | 48 (`48/48 通过`) | **Regression guards**: an invalid plan and a middle-row drop return errors while the **process survives** (BUG-1 / BUG-1b); a damaged frame returns an error (BUG-2); `scan` locates without leaking text; `rollback` dry-run/execute/retention boundary/quarantine backup; `undo` find/execute/pre-undo snapshot/error when no backup exists; the refusal of `apply`/`rollback`/`undo` on the current session; and the whole in-session hiding path: `nodes` on one line within 200 cells, **newest first**, `[index] line tool size`, tool names resolved, no body, no internal `seq`; `hide <index>` resolution and out-of-range error; `hide --lines` hit and miss; the `--commit` replacement-node shape and its **adjacent** `compaction/prune` price tag |
| `test/preflight.mjs` | none (smoke) | Module imports; `name`/`inject`/`apply` shape; the command registers (prints the hint and `recordInput`); `list` runs; and the `hide` error text for an unknown session / unknown subcommand / missing plan file / no agent / a session with no surface |
| `session-surgery/selftest.mjs` | 34 (`34/34 通过`) | **Engine / CLI main path**: frame scanning and per-frame statistics; hit location that never echoes the text; `paths` printing no values; all three in-place rewrites while row count, frame count, and `seq` stay unchanged; untouched frames byte-for-byte; a middle-row drop refused without `renumber`; the same drop allowed with `renumber`; a suffix drop allowed; header drop/blank refused; rewriting the structural key `seq` refused; a corrupt file rejected; `verify` exiting cleanly; `plan` writing no files |

```sh
# inside dsh-plugin-redact/
node test/handler.selftest.mjs     # exit code 1 on failure; prints N/M 通过
node test/bugfix-regression.mjs    # regression guards, 48/48 通过
node test/preflight.mjs            # smoke check, prints observations only

# the engine/CLI one lives next door
cd ../session-surgery
node selftest.mjs                  # 34/34 通过
```

All four need **Node >= 22.15** (zstd APIs) and none requires DSH to be running. `handler.selftest.mjs` points `DSH_HOME` at a `mkdtemp` directory (fixtures are deleted afterwards) and prints **the byte size and first 12 sha256 characters of the tested `index.js`**, so you can see which revision passed; it also installs a safety net that turns `process.exit` into a throw — that path is no longer reached now that the engine throws `RedactError`, and the suite records the fact as one of its probes (see §6).

`test/` is **not** in `package.json`'s `files` list, so these scripts live in the source repository only and are not published; `package.json` also declares no `scripts` — run them with `node <file>` directly.

---

## 6. Limitations, honestly

1. **Scope is the session log and its derived caches only.** The tool covers `<DSH_HOME>/sessions/**/session.vN.jsonl.zstd` plus the cache files `purge` lists; nothing else.
2. **Only the highest-version log is targeted.** Older files such as `session.v2.jsonl.zstd` for the same session are **not** rewritten and still hold the text. Use `list` / `graph` to confirm there is no older version or forked copy, then deal with those yourself.
3. **Anything that already left the machine cannot be retracted.** Content already written to files, exported as a report, uploaded elsewhere, or sent as a request to a model provider is beyond reach. The tool repairs **the local session log copy** only.
4. **It does not prevent the content from arriving.** This is after-the-fact repair: content lands first, and is removed afterwards. The complementary approach is a **preventive policy plugin** that replaces a tool result before it is persisted (see below).
5. **`apply` on the current session is an in-place overwrite, not a rename.** Under `--allow-live` it goes `open('r+')` → write → `ftruncate` → `fsync` (a rename could collide with an appending handle, especially on Windows); without it, the current session is always refused. Even so, **the running process still holds the old text in memory** and its later provider requests still carry it — the success output tells you to reopen the session, and **requests already sent cannot be recalled**. The right move for the current session remains `hide --commit` first (immediate, no restart, no bytes removed), leaving the bytes to the offline CLI once the session is closed.
6. **Engine-level rejections now throw `RedactError` instead of calling `process.exit` (an early defect, since fixed).** The earlier implementation signalled fatal errors by writing to stderr and exiting the process, which made `/redact plan|apply` kill the host process; `die()` now throws `RedactError`, the plugin's `try/catch` turns it into an ordinary `未执行：<reason>` error result, and the offline CLI converts it at the top of `main()` into stderr plus exit code 1 (externally unchanged). `test/bugfix-regression.mjs` (BUG-1 / BUG-1b / BUG-2) and the probes in `test/handler.selftest.mjs` guard this regression.
7. **`renumber` rewrites structure.** It changes every row's `seq` and remaps backward references; a row that references a deleted row counts as a dangling reference and the run is **refused** — use `blankLines` for that case instead.
8. **Torn tails are dropped by default.** A partially written trailing frame is discarded on rewrite unless the plan says `"keepTorn": true`. Check `inspect`'s torn-tail offset first.
9. **Untouched frames are preserved byte-for-byte; modified frames are recompressed**, so the file size will change (it can grow). That is expected and does not mean text survived.
10. **Paths containing spaces need quoting in the TUI** (arguments are split on `"..."` / `'...'` / whitespace, with outer quotes stripped); relative paths resolve against the host process's cwd, so prefer absolute paths.
11. **Node >= 22.15 is required** (zstd APIs).
12. **The quarantine backup cuts both ways**: it lets you roll back, and it **still contains the original text**. Forgetting to delete it means the redaction did not really happen.
13. **`hide` is not redaction.** It only appends `surfaceOp` replacement nodes to move content out of model view; the original stays in the log in full (its own success message says so). It handles **`tool/result` nodes only** (user and assistant messages are skipped), and it always substitutes the configured `placeholder` (so a plan's `replace` does nothing under `hide`). It locates targets three ways — `substitutions[].find` in a `<plan.json>`, an `<index>` from `/redact nodes`, or `--lines <log line>`. The last two have nothing to do with `find`, so they **never require the original text to be written into any file**.
14. `scan` honours `substitutions[].lines`: it reports only rows inside the restricted range, i.e. the rows `apply` would actually change, and says so with `（已有 substitutions[].lines 限定，此处只报限定区间内的命中，与 apply 语义一致）`. `verify` now returns `日志无法解析：<reason>` for a log with a damaged frame header rather than throwing, but the offline `dsh-redact verify` is still the better check for such a file — it reports through exit code 2.
15. **`rollback` depends on `turn/end` events.** A log with no `turn/end` cannot be rolled back at all (it is refused), and at least one turn must remain — it cannot empty a session. A cut that would remove an inherited `session/end-seed` marker is refused as well.
16. **A notification is always one line and at most 200 display cells.** That is dsh-tui's rendering constraint (see §3.1), not a choice this tool makes: newlines become spaces, anything longer is cut off, and a CJK character occupies 2 cells. `list` / `nodes` / `hide` are already designed around it — one line, most important information first — and will deliberately drop trailing entries (`…另N个`). **Do not design your workflow around copying a long string out of a notification**: to hide the newest node, just type `/redact hide 1 --commit`.
17. **`hide <index>` depends on an in-memory listing.** The index refers to **this session's most recent `/redact nodes`**, which lives only in the host process's memory, kept per session: without a prior `nodes` (or after a process restart) it reports `还没有节点列表，请先运行 /redact nodes`. If you would rather not depend on that, use `hide --lines <line>` (when you know the number) or `hide <plan.json>`.

### Complementary approach: a preventive policy plugin

This tool is **reactive**. To reduce what is persisted in the first place you need a separate plugin sitting before tool results are written. The available seams are `tools/execute` (an around-dispatch waterfall: `(exec, next) => Promise<ToolExecutionResult>`, where a wrapper returns a replacement result) and `tools/post-execute` (`(exec, result, next) => Promise<PostToolDecision>`, which may accept, replace, or block a normalized result). A live example of the latter family is the community plugin `dsh-secret-redactor` (it masks tool results), whose own README concedes that **the durable log still stores the raw canonical value** — precisely why prevention and repair have to be separate jobs.

There is one **easy-to-get-wrong detail** in that seam: replace the result's **canonical `value`**, not `content` alone. A successful result's `content` and `meta` are both *projected from* `value` by the tool's own projectors (`render` / `presentationMeta`), and `meta` is **persisted verbatim** on the `tool/result` event — so masking only `content` leaks the original through the persisted `meta`. Replacing `value` regenerates both projections. Note the interface makes the two mutually exclusive: supplying both `value` and `content` in one decision throws a `TypeError`.

(That paragraph describes DSH's tool-result pipeline, not a feature of this package — this package registers no tool-result hooks. Verify against the type definitions of the DSH version you run.)

---

## 7. Prior art: why another plugin

The DSH plugin ecosystem has many history-related plugins, but **none of them rewrites the persisted session log's content**. All of the following are real plugins (names taken from the ecosystem survey kept alongside this package, `dsh-tui-redaction-plugin-survey.md`):

| Plugin | What it actually does | Why it is not in-place redaction |
|---|---|---|
| `dsh-easyrewrite` | Archives the original session and substitutes a same-named session truncated before the target message, then re-sends the edited text (Web UI only) | The original log is **archived**, not erased; no substring or tool-result scrubbing |
| `dsh-conversation-rewind` | Appends a `SurfaceOp` replacement marker that hides the message from the transcript and later model context (Web UI only) | Removed **from context**, kept on disk |
| `dsh-message-edit` | Each edit/retry creates a **new session version** (Web UI only) | Explicitly "does not rewrite Session events in place; history is append-only"; old sessions retained |
| `dsh-undo` | `/undo` appends a `surface/rewind` event, `/redo` a `surface/restore` | Append-only by design: message nodes, IDs, tool-call correlations, and log events all retained |
| `dsh-session-cleaner` | Whole session: archives and **physically deletes** the log directory; single message: surface replace | Message-level keeps "the original events in the log and human transcript"; whole-session deletion is **irreversible, with no backup** |
| `dsh-sess` | **Permanently deletes cold sessions** via `ctx.sessionPersistence.locate()` (Web UI only) | Whole-session deletion only, no message-level operation, no unarchive |
| `@anionex/dsh-turn-rewind`, `dsh-shadow-rewind` | Restore **project file** snapshots / fork a new session | They act on files and branches, not on log content |
| `dsh-secret-redactor` | Hooks the tool-result path and masks the text the model sees | Its README states plainly that **the durable log keeps the raw canonical value** and that log-level redaction is still on the roadmap |
| `dsh-telemetry-redactor` | Redacts the **outbound telemetry** copy only | "It never rewrites the canonical session log" |
| `dsh-recall`, `dsh-session-index`, `@deepseek-ai/dsh-session-health` | Search / indexing / frame-level diagnostics of multi-frame zstd logs | All **read-only** |

The conclusion of that survey: **every one of these preserves the log** — append-only is the ecosystem norm. The only thing that changes bytes on disk is whole-session deletion, which is irreversible and unbacked; message-level operations are surface replacements. **"Open `session.vN.jsonl.zstd`, rewrite a specific piece of content, keep the log readable by the reader, and leave a restorable backup" is not available off the shelf.**

Note also that `dsh-tui`'s built-in `/rewind` is **not** redaction. It forks: it finds the start event of the turn owning the message, creates a branch session via session fork, replays history before that boundary, and puts the original message back in the composer. **The original `session.vN.jsonl.zstd` stays on disk.** It changes what you see next, not what remains on disk — the two are complementary, not substitutes.

This plugin fills exactly that gap: **row-level, in-place, verifiable log-content redaction with a quarantine backup, launchable from the TUI.** It deliberately does not do whole-session deletion (other plugins do) or context-level rewind (the TUI ships one).

One clarification: `/redact hide` uses the same class of mechanism as `dsh-conversation-rewind` (appending `surfaceOp` replacement nodes to take content out of model view), but this package keeps it deliberately narrow — `tool/result` nodes only, no branch-tree UI — and treats it as the "stop the bleeding" first step, paired with a byte-level, backed-up `apply`.

---

## 8. Publishing to npm / how a consumer installs it

### 8.1 Name and scope

* The official docs mandate **no** naming or scope. Community convention is an unscoped `dsh-*` (`dsh-easyrewrite`, `dsh-shadow-rewind`, `dsh-telemetry-redactor`) or an owner scope `@owner/dsh-*`.
* **Do not assume the `@deepseek-ai` scope is available.** Every package seen under it resolves to an official or official-adjacent publisher.
* Claim the name before publishing:

  ```sh
  npm view dsh-plugin-redact    # a 404 means the name is free
  ```

### 8.2 Checks before publishing

1. **`files` must contain everything used at runtime**, and the file `dsh.bundle.patch` points at must resolve inside the installed package. This package's `files` list is complete:

   ```json
   "files": ["index.js", "cordis.patch.yml", "lib/engine.mjs", "bin/dsh-redact.mjs", "README.md", "README.zh.md"]
   ```

   * `index.js` — the plugin entry (`export const name` / `export const inject` / `export function apply`)
   * `cordis.patch.yml` — the layer `dsh.bundle.patch` points at
   * `lib/engine.mjs` — the engine, imported relatively by `index.js`
   * `bin/dsh-redact.mjs` — the offline CLI (`bin.dsh-redact`)
   * both READMEs

   The repository's `test/` (`handler.selftest.mjs`, `bugfix-regression.mjs`, `preflight.mjs`, plus the build-time `patch-engine-error-model.mjs`) is **deliberately not in `files`**, so the self-tests are not published. Add them if you want consumers to be able to run them.
2. **Preview the tarball** to confirm nothing is missing and nothing private is included:

   ```sh
   npm pack --dry-run
   ```
3. Keep `engines.node` at `>=22.15.0` (required by the zstd APIs). The `peerDependencies` (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-commands`) are optional in this package (`peerDependenciesMeta` marks them so), which avoids install friction.
4. Make sure the package contains **no test fixtures, `plan.json`, or `needle.txt`** leftovers.

### 8.3 Publishing

```sh
npm login
npm publish                    # unscoped package
npm publish --access public    # scoped package (@you/dsh-plugin-redact) — first publish must be explicit
```

* Publishing to a registry is **not required**: the official docs support npm packages, `pnpm pack` tarballs, and git dependencies — so `dsh plugin --profile <name> add ./dsh-plugin-redact` or `add github:you/dsh-plugin-redact#<commit>` is a valid distribution path too.
* With a git dependency, pnpm >= 10 refuses to run the dependency's `prepare` until the consumer copies the key pnpm prints into the profile's `pnpm-workspace.yaml` under `allowBuilds` and retries; **publishing to npm sidesteps this entirely** since the artifacts are already present.
* Follow semver and use `npm version patch|minor` as needed; consumers upgrade with `dsh plugin --profile <name> update`.

### 8.4 How a consumer installs it

```sh
dsh plugin --profile <name> add dsh-plugin-redact          # from npm
dsh plugin --profile <name> add ./dsh-plugin-redact        # local directory
dsh plugin --profile <name> add github:you/dsh-plugin-redact#<commit>   # commit-pinned
dsh --profile <name> --dump-config                         # confirm the dsh-redact row appears
```

The offline CLI ships with the package (`bin.dsh-redact`); from the profile directory it is available as `npx dsh-redact`, or invoke its entry file directly.

### 8.5 Three reminders when distributing

* **DSH has no official plugin registry.** The official docs document only npm / tarball / git distribution and state that publishing to a registry is not required; there is no official submission form or review step. Community directories (the cordis.run marketplace and its auto-generated Awesome list, the `dsh-plugin-verify` verification repository, dshfind.com / dsh.so, and the `dsh-tui-ecosystem` + `dsh-ecosystem-spec` admission spec) are **community-run with their own processes** and imply no official endorsement.
* **Third-party plugins run as trusted host code, outside the sandbox.** Installing one means executing its code with your machine's permissions, and it can read and write your session logs — which is exactly how this plugin works. Review it like any local program, and when publishing, state your permission needs plainly (this package only `inject`s `commands`, publishes no service, makes no network calls, and touches only the `root` / `cacheRoot` you configure).
* **Never put real sensitive content in a README.** Examples, issues, screenshots, and test fixtures linger in public records — which is the very reason this tool exists.

---

## 9. License

MIT.
