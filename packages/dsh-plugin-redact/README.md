# dsh-plugin-redact

**In-place redaction and row-level rollback for DSH session logs (`session.vN.jsonl.zstd`), usable from inside `dsh-tui`.**

No new session, no deleting the whole conversation, no moving the log around: it rewrites the exact bytes in the original file and leaves the log readable by the DSH reader.

| | |
|---|---|
| Package | `dsh-plugin-redact` |
| Version | 0.1.0 |
| License | MIT |
| Runtime | Node.js **>= 22.15.0** (uses `zlib.zstdCompressSync` / `zstdDecompressSync`) |
| In-TUI command | `/redact list\|nodes\|pick\|scan\|hide\|plan\|apply\|verify\|purge\|rollback\|undo` |
| Offline CLI | `dsh-redact inspect\|paths\|verify\|plan\|apply\|cut\|graph` |
| Hard dependency | Consumes the host `commands` service only (`inject: ['commands']`); publishes no service. `/redact pick` additionally needs the TUI row's `tuiDialogs` **and** an explicit `allowDialogs: true` (**off by default** — see §2.5) |

---

## 0. What problem it solves

Once a tool result, command output, or fetched page enters a session, a persistence batch writes it into `session.vN.jsonl.zstd`, where it then **sits on disk indefinitely** — replayed in later history, fed back into later context, indexed or exported. The content need not be a "secret": it may be material you are not allowed to retain, a credential, or simply **wrong or outdated information that should stop influencing later decisions**. You decide the criterion; this tool only guarantees that the bytes already on disk are removed or rewritten — **without corrupting the log**.

It does two things: **rewrite** (replace matched text/fields in place, or blank a whole line) and **cut** (drop trailing rows, or middle rows with an explicit renumber pass). Afterwards the session still opens, replays, and appends normally.

Keep four different outcomes apart, because four subcommands own them:

* **`/redact hide`** — **immediately** removes matching tool results from the **current session's model view** by appending `surfaceOp: {op:'replace'}` replacement nodes. The model stops seeing them from the next request, **with no restart**. **Disk bytes are unchanged.** It locates its targets three ways: a `find` in `plan.json`, an index from `/redact nodes`, or a log line number (see §3.1). To **see the complete list and pick from it**, use **`/redact pick`**: it renders the nodes multi-line in the TUI's own panel and lets you choose with the arrow keys, **free of the 200-cell single-line limit**. Each entry shows **index / log line / turn / tool name / size**, with the tool call's **command line** on the line below it (governed by `argsCells`, which can truncate it or switch it off entirely) — together these are what let you tell *which* node you are looking at (see §3.2). **The tool result's body is never shown.** ⚠️ `pick` is **off by default** (`allowDialogs: false`): a modal dialog makes the TUI yield the chat keyboard, and a pending approval panel then deadlocks the UI (see §2.5). Enabling it takes explicit configuration; without it, use `/redact nodes` for the numbering plus `/redact hide <index> --commit` — nothing else is affected.
* **`/redact apply`** — actually **rewrites the log bytes on disk** (in place, same row count). It requires the session not to be in use (otherwise an explicit `--allow-live`), so it is best run through the offline CLI while the session is closed.
* **`/redact rollback <turns>`** — **retracts conversation that already happened**: truncates the last N complete turns at a `turn/end` boundary. This is a suffix drop, the safest kind of deletion.
* **`/redact undo`** — **reverts your own redaction**: restores from the newest quarantine backup (**validated before it is installed**: frames decodable, header legal, `seq` dense, references legal, no torn tail, and no fewer events than the current log; a backup that fails is refused with a pointer to an older `.quarantine-*` / `.before-undo-*` copy).

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
| `argsCells` | `120` | Display-cell budget (a CJK character costs 2) for the **tool-call command line** shown in listings. The command line is what makes an entry recognisable, but it can itself contain sensitive search terms, hence the switch: **`0` shows no command line at all** (nothing in the listing file or the panel — not even a `…`). It affects only the `nodes full` file and `pick`'s option `description`; the `nodes` notification **never shows a command line** and is unaffected |
| `dialogTimeoutMs` | `15000` | The `timeoutMs` passed to both of `pick`'s dialogs. It is the bound on "how long the UI may stay unusable when the panel is not rendered" (see §2.5); **`0` disables dialogs entirely** — `pick` returns an error and **never calls** the dialog service. The default used to be 120000 (2 minutes), which was a bad bet: the user hit exactly that freeze in practice |
| `allowDialogs` | `false` | The **master switch for `pick`'s modal dialogs, off by default** (rationale in §2.5): parking the promise in `TuiDialogStore` makes chat yield the keyboard unconditionally (the prompt is disabled), the dialog's only mount point can be silently overridden by an approval panel, and approval has no timeout — so "press `pick` while an approval is pending" necessarily locks the keyboard, `Ctrl+C` cannot even exit, and only the timeout frees it. Set `true` to enable `pick`; while it is off, `pick` returns an explanation pointing at `nodes` + `hide <index>`. A non-boolean value throws |

`<DSH_HOME>` falls back to `~/.dsh`. The shipped `cordis.patch.yml` uses the deployment's own `!!js dshHomePath(...)` helper, exactly like the official `session-persistence-jsonl` row, so it follows `DSH_HOME`.

**Config validation (done synchronously in `apply()`, so it fails early and visibly):**

* **An empty `config:` (YAML hands over `null`) or no config at all (`undefined`) is treated as `{}`**, with each of the six fields taking its default. This is deliberate: otherwise one empty `config:` would abort the whole profile's boot.
* **Still rejected**: non-objects (strings, arrays) and any **non-string or empty-string** value for `root` / `cacheRoot` / `placeholder`. The errors read `dsh-redact: invalid config: expected an object` and `dsh-redact: invalid config: $.root must be a non-empty string`.
* **The two numeric fields must be non-negative integers**: `argsCells` / `dialogTimeoutMs` given as `-1`, `1.5`, `'5000'` or `null` all throw at boot and **register no command** — `dsh-redact: invalid config: $.argsCells must be a non-negative integer`, `dsh-redact: invalid config: $.dialogTimeoutMs must be a non-negative integer`. `0` is valid and meaningful ("show no command line" and "disable dialogs" respectively).
* **`allowDialogs` must be a boolean**: `'true'`, `1` or `null` all throw `dsh-redact: invalid config: $.allowDialogs must be a boolean` (and register no command); omitting it means the default `false`.
* **Unknown keys only warn, never reject** (matching the platform's own config semantics, so a slipped key name cannot break boot): `dsh-redact: ignoring unknown config key(s): palceholder, extra`, emitted through `ctx.logger.warn`.
* This package does **not** export a Schemastery `Config`: when installed as `link:`, the package's own real path cannot resolve `node_modules` upwards and `@deepseek-ai/schemastery` is unresolvable (observed as `ERR_MODULE_NOT_FOUND`). The equivalent validation above is therefore hand-written inside `apply()`.

### 2.4 Confirm it mounted

```sh
dsh --profile <name> --dump-config     # prints the composed config without booting
```

The output should contain the `id: dsh-redact` row, annotated with the layer it came from. *(This command also rewrites the profile's generated empty `cordis.yml` and may heal `profiles/node_modules` links; both are idempotent.)*

In a `patchReload: live` profile, editing `cordis.patch.yml` takes effect without a restart, and the new command enters the TUI's `/` menu live via `commands/change`. **Editing the contents of an already-imported module is not hot** — restart or rename the file. Creating the plugin file for the first time needs no restart.

### 2.5 `/redact pick` is **optional** and off by default: enabling it takes two things (**install requirement**)

> [!IMPORTANT]
> **`pick` is off by default (`allowDialogs: false`) — not out of caution, but because of a root-cause finding.** Parking the dialog's promise in the TUI's `TuiDialogStore` makes chat **yield the keyboard unconditionally** (`Chat.js:2566`: the prompt is disabled while a questionnaire / approval / plugin dialog is pending); the dialog panel's **only** mount point (`Chat.js:3585`) is silently overridden by an approval panel, and approval has **no timeout** — so pressing `/redact pick` while an approval is pending necessarily locks the keyboard, `Ctrl+C` cannot even exit (`exitOnCtrlC: false`), and only the timeout frees it. **The only structurally safe move is not to park the promise at all**, so the default path is `/redact nodes` for the numbering → `/redact hide <index> --commit` (no functionality is lost).
>
> To actually use the panel, **two things must both hold**:
> 1. **Config `allowDialogs: true`** — the master switch (default `false`). While it is off, `pick` returns this and **never touches the service**:
>    ```
>    pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险
>    ```
> 2. **A row-level `inject: [commands, tuiDialogs]`** — this removes the startup "admission race" (next paragraph). The packaged `cordis.patch.tui.yml` already writes this step *and* the one above.

**Why the row-level `inject` is still needed.** The `tuiDialogs` runtime has an admission guard **outside** its `try/catch`: the caller must be a **registered, live, non-root activation** (`@deepseek-harness-tui/dsh-tui`, `lib/types/dsh-adapter/dialogs.js:103-111`: when `bindOwnerEffect(...)` does not bind, it immediately runs `pending.onAbort()` and the promise settles with the cancelled value; the registration itself is established by `compositionRoot(ctx)` in the `TuiDialogRuntime` constructor, same file `:185`). If this row becomes ACTIVE **before** the first dsh-tui adapter module that installs that composition-root tracker, every `select` / `confirm` only writes one logger warning and returns — no panel, and the user sees nothing but "cancelled". **A row-level `inject` makes Cordis wait for that service before activating this row**, which removes the race (measured: in the worst order the panel went from 0/6 to 6/6).

**The packaged layer is `cordis.patch.tui.yml`** (shipped with the package; `exports` also resolves `dsh-plugin-redact/cordis.patch.tui.yml`); it writes both the row-level `inject` and `allowDialogs: true` into that row. The row you want when enabling `pick` looks like this:

```yaml
# the row that enables /redact pick (row-level inject + an explicit opt-in)
- insert:
    - id: dsh-redact
      name: dsh-plugin-redact
      inject: [commands, tuiDialogs]
      config:
        root: !!js dshHomePath('sessions')
        placeholder: '[已移除]'
        cacheRoot: !!js dshHomePath('storages')
        allowDialogs: true
```

(The packaged `cordis.patch.tui.yml` also carries a long comment block explaining the admission guard, the cost, and why you must **not** try an `!!js` `disabled` self-guard to choose between the variants automatically — `Entry.disabled` is a live getter, so the verdict flips with mount progress and the boot aborts.)

Three ways to use it, pick one:

1. **Paste it into your own profile patch layer** (recommended, most direct): copy those `insert` lines into `<DSH_HOME>/profiles/<name>/cordis.patch.yml` (both the packaged file and the snippet above already carry `allowDialogs: true` in the config — do not drop it when copying).
2. **Point `--patch` at the packaged file**:
   ```sh
   dsh --profile <name> --patch "C:/path/to/node_modules/dsh-plugin-redact/cordis.patch.tui.yml"
   # Windows absolute paths need a file:// URL: node -p "require('node:url').pathToFileURL('C:/.../cordis.patch.tui.yml').href"
   ```
   That file's config carries all four fields (including `allowDialogs: true`), so this route is **complete on its own**; layers from several `--patch` flags stack in order.
3. **Copy the snippet**: if you only want the panel and not the file itself, copy the YAML above.

Three measured semantics that save rework:

* **A row-level `inject` is APPENDED, not a replacement**: the module's static `commands` declaration still applies (cordis merges via `Inject.resolve(entry.options.inject, fiber.inject)`), so `commands` inside `[commands, tuiDialogs]` is a **harmless duplicate** — you do not have to choose between them.
* **`config` is a whole-row replacement** (a matching patch replaces the entire config; there is no deep merge), so write every field you want to take effect into that row — **which is exactly why `allowDialogs: true` has to be in it**, not inherited from somewhere else.
* After applying it, `dsh --profile <name> --dump-config` shows that row's `inject` and config (see §2.4).

> [!WARNING]
> **Cost: apply this layer only when you run a dsh-tui frontend and genuinely want that panel.** If your profile has no `tuiDialogs` provider (non-TUI frontend, or the dsh-tui row disabled / failed to load), this row stays PENDING (`state 0`) forever, and the boot promotes a PENDING row to a fatal error — **the whole profile fails to boot**, not a single row failing quietly.

**Why the packaged default layer `cordis.patch.yml` deliberately omits that `inject`**: on a **non-TUI profile (e.g. web) `tuiDialogs` never exists**, so declaring it would leave the row PENDING and abort the whole profile boot. The default layer therefore stays **graceful**.

Off-by-default and degraded behaviour are both explicit — never silent:

* `allowDialogs !== true` → the "off by default" explanation above (`kind: error`), without touching the dialog service;
* `allowDialogs` on but `dialogTimeoutMs: 0` → `对话框已被配置禁用（dialogTimeoutMs: 0）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`;
* `allowDialogs` on but the frontend has no such service → `当前前端没有对话框服务 tuiDialogs · 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`;
* `allowDialogs` on and the service present, but the host did not admit this row (the admission race) → the plugin **uses elapsed time** to tell (nobody presses Esc within 50 ms):
  ```
  对话框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件
  ```
  The confirm panel is the same:
  ```
  确认框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact hide <序号> --commit
  ```

In other words, **whether it is off or degraded, `pick` never fails silently** — it separates "the panel never opened" from "the human really cancelled" (which takes longer and answers `已取消`). The `选择 /redact pick · ` hint in `nodes`' tail appears **only when `allowDialogs: true` and `tuiDialogs` is available**, so it never advertises a path you have switched off.

---

## 3. Usage

### 3.1 `/redact` subcommands

`/redact` addresses sessions by **session id** (`--session <id>`), not by log path; without `--session` the target is **the current session**. Its argument hint in the `/` menu is `[list|nodes|pick|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]`.

`nodes` / `hide` / `pick` read and write the **live session's in-memory surface**, so they **only accept the current session**; pointing `--session` at another one errors out instead of quietly showing the current session.

| Subcommand | Syntax | Output / behaviour |
|---|---|---|
| `list` | `/redact list` | Sessions by descending size, **folded into one line**: `共 N 个会话（按体积）：` + segments of `<first 8 chars of id> <size>` (human-readable, e.g. `1.5MB` / `805.4KB` / `551B`) joined by ` ｜ `, with `(当前)` appended to the current session's segment; the budget is 200 display cells, so trailing entries collapse into ` …另M个` and the line normally ends with ` 用 /redact nodes 看当前会话`. ⚠️ With enough sessions the budget runs out and even that trailing hint is cut to `用 /redact nodes …`. This is also the default when no subcommand is given |
| `scan` | `/redact scan <plan.json> [--session <id>]` | **Locate only, one line**: `会话 <first 8 chars of id> · 共 N 行 · 命中 M 行：<line numbers> · 未改动任何文件`. At most **8** hit line numbers are listed; beyond that it appends `…共M` directly (e.g. `命中 14 行：2,3,4,5,6,7,8,9…共14`). With 0 hits the `：<line numbers>` part is absent. A plan carrying `substitutions[].lines` adds ` · 已按 substitutions[].lines 限定`. The count includes the header row. ⚠️ It uses only `substitutions[].find` as probes — a plan containing only `setFields`/`blankLines` cannot be located and reports 0 hits |
| `nodes` | `/redact nodes [page\|full]` | Lists the **current session's** `tool/result` surface nodes, **newest first**. Each entry reads `[index] line 轮T tool size`; a single-page listing looks like `共 3 个 tool/result（最新在前）：[1] 7 轮3 tool-2 149B ｜ [2] 5 轮2 tool-1 149B ｜ [3] 3 轮1 tool-0 149B 全文 /redact nodes full · 隐藏 /redact hide <序号>`. **Paged**: it splits on the **display-cell budget**, not a fixed item count (a fixed count would leave "the few that no longer fit" permanently invisible); with several pages the head becomes `共 N 个 tool/result（最新在前）第1/7页：`, a non-final page continues ` 续 /redact nodes 2（还有17条） · `, and the last page drops the "continue" part, keeping only ` 全文 … · 隐藏 …`; a single page omits `第x/y页` and ends the head with `：`. **Indices stay continuous across pages** (20 nodes measured at 7 pages with indices 1..20 and no gaps), so an index seen on any page can be fed straight to `hide`; an out-of-range page silently falls back to the last page. `T` is the `tool/result` event's **own** `data.turn` (`-` when absent); the tool name is resolved by looking the result's `message.source.callId` back up in the `tool/call` events (unresolved shows `(未知工具)`); sizes ≥1KB render as `12.3KB`. `nodes full` (or `--full`) writes the **complete list** to `%TEMP%\dsh-redact-nodes-<session id>.txt`, one row per node like `[1] 轮 3  tool-2  149B  行 7  {"cmd":"very-long-command-line-2","query":"SYNTHETIC-…"}  → /redact hide 1 --commit` (the command line is flattened by `oneLine()` and truncated to `argsCells`; with `0` the whole segment is omitted and **no placeholder is left**), and answers `完整清单已写入 <path>（共 N 条，序号可直接 /redact hide <序号>）`. **The body is never shown** (the complete identification story is in §3.2); the listing is remembered per session and is what `/redact hide <序号>` refers to. ⚠️ **Other sessions are explicitly refused**: `nodes 只能列出当前会话的节点（surface 是活会话的内存状态） · 其它会话请用 /redact apply 处理其日志`. When `allowDialogs: true` and `tuiDialogs` is available the tail gains `选择 /redact pick · ` (either one missing suppresses it) |
| `pick` | `/redact pick` | **Choose a node with the arrow keys in a TUI panel** — the right answer to "show me the whole list and let me select". It is **not subject to the 200-cell single-line limit** (the dialog is rendered in the TUI's own chrome). ⚠️ **Off by default**: `pick`'s first gate is `allowDialogs` (**default `false`**, see §2.3/§2.5); while it is off the command returns `pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险` and **never touches the dialog service**; the second gate is `dialogTimeoutMs: 0` (`对话框已被配置禁用（dialogTimeoutMs: 0）· …`); only the third probes the service (`当前前端没有对话框服务 tuiDialogs · …`). Once enabled it still shows **metadata only**: it runs `select` (a multi-line list whose labels read `[2] 行 5 轮 2 · tool-1 · 149B`, with that call's **command line** as the entry's `description` on the next row; with `argsCells: 0` the `description` is not set at all), then `confirm` for a second confirmation (title `隐藏 [2] 行 5 · tool-1 · 149B？`, message `隐藏后从下一轮请求起模型不再看到它（磁盘字节仍在）。该节点会被永久遮蔽，无法还原。`, buttons `隐藏` / `取消`), and on confirmation performs the same surface replacement as `hide`. Success: `已隐藏 [2] 行 5 · tool-1 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`. **"The panel never opened" and "the human cancelled" are reported separately**: a **human** cancel (Esc / timeout, ≥ 50 ms on the plugin's clock) yields `已取消`; a cancel that arrives within **50 ms** means the host did not admit this row → `对话框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`, and the same for confirmation → `确认框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact hide <序号> --commit` (the fix is §2.5). **Current session only** (`pick 只作用于当前会话；其它会话请用 /redact apply 重写日志。`). **At most 60 entries per invocation**: beyond that the title spells it out — `选择要隐藏的节点（共 70 个，仅列最新 60 个；其余用 /redact hide <序号>）`; otherwise it is `选择要隐藏的节点（共 N 个，最新在前）`. Both dialogs carry `timeoutMs: dialogTimeoutMs` (**default 15000**). A throwing dialog call yields `对话框调用失败：<reason>`; picking an id that does not exist yields `无效的选择：<id>` |
| `hide` | `/redact hide <index\|plan.json> [--commit]`, `/redact hide --lines <line> [--commit]` | **Current session only**, three ways to locate targets (see below): ① `<index>` refers to entry N of the **most recent `/redact nodes`**; ② `<plan.json>` finds the `tool/result` **surface nodes** whose `data.message` contains any `substitutions[].find`; ③ `--lines <line>` targets by log line number (exactly the number `nodes` printed). Without `--commit` it only dry-runs (`试算：将隐藏 N 个节点（seq 5）· 加 --commit 执行`, or `试算：未命中任何 tool/result 节点`; nothing appended, nothing on disk touched); with `--commit` it appends one replacement node per target and reports `已隐藏 N 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）` (or `未命中任何 tool/result 节点，未做改动` when nothing matched). ⚠️ When several targets are queued and one **fails midway**, the already-landed work is reported honestly: `第 2 个节点（seq 2）的消息形态不受支持（content 里没有可替换的文本块），未做改动 · 已有 1 个节点被永久遮蔽（seq 1），该变更已生效且不可撤销，建议重开会话`. **Disk bytes unchanged**; effective from the next request |
| `plan` | `/redact plan <plan.json> [--session <id>]` | **Dry run, writes nothing, one line**: `试算 OK（未写盘） · <id8> · 行 删x/空x/改x/换x · 帧 留x/写x · 自检通过`. The `/重编号x` and `/移除x` parts are appended only when those counts are >0 (e.g. `行 删0/空0/改0/换1 · 帧 留1/写3`) |
| `apply` | `/redact apply <plan.json> [--session <id>] [--allow-live]` | **Rewrites in place, one line**: records the file revision → reads it → plans → re-checks the revision (any append in between refuses the whole run) → writes the quarantine backup → commits → purges derived caches. The success line now **leads with the backup and its "still contains the original" warning** (only the first 200 cells survive): `已脱敏 sess-bet · 备份 session.v3.jsonl.zstd.quarantine-<timestamp>（仍含原文，确认无误后自行删除） · 行 删0/空0/改0/换0 · 帧 留1/写1 · 缓存清理 0 · 另有 7 处需自行处理（见文档 安全模型）`; under `--allow-live` against the current session it also carries ` · 重开会话后内存历史才更新`. Refusing the current session also **leads with the way out**: `拒绝改写在用会话 sess-alp（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact apply <计划.json> --session sess-alp`. Under `--allow-live` a **torn tail** causes a refusal (the write handle caches a truncation offset computed for the pre-rewrite layout, which risks silent corruption) |
| `verify` | `/redact verify [--session <id>]` | **One-line self-check.** Pass: `✓ sess-alp · 帧 4 · 行 9 · 头部合法 · seq 密集 · 引用合法 · 读取端可打开`; fail: `✗ <id8> · 帧 N · 行 N · 问题：<reason>` (with `kind` also `error`; a reference problem reports the reference check's reason, otherwise the torn-tail offset / `seq` gap / parse-failure count). A damaged frame header yields `日志无法解析：<reason>` instead of an exception |
| `purge` | `/redact purge [--session <id>]` | **One line**: `已清理缓存 N 个 · <id8>`; when copies this tool will not touch remain, it appends ` · 仍有 N 处本工具不动：<first path> 等` (paths only, never their content). A deletion failure never changes the command's outcome — it only appends `（失败 N：<first reason>）` after the count |
| `rollback` | `/redact rollback <turns> [--session <id>] [--commit]` | **Turn-based rollback, one line**: counts the `turn/end` boundaries and truncates the last N complete turns (1 turn when the count is omitted). Dry run: `会话 sess-rol · 共 3 轮 · 回退 1 轮 → 保留 2 轮 · 删 2 行（自第 6 行起截断） · 试算未写盘，加 --commit 执行`; `--commit` writes and continues with ` · 备份 <name>（仍含原文，确认无误后自行删除） · 缓存清理 N`, then ` · 重开会话后生效` or ` · 下次打开该会话即为回退后状态` depending on whether it is the current session. Refusing the current session: `拒绝截断在用会话 sess-rol · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 rollback 1 --session sess-rol`. At least one turn must remain; a log with no `turn/end` is refused outright |
| `undo` | `/redact undo [--session <id>] [--commit]` | **Reverts the last redaction, one line**: finds the **newest** quarantine backup for that log. Dry run: `sess-bet · 备份 session.v3.jsonl.zstd.quarantine-<timestamp>（271B）· 当前 271B · 试算未写盘，加 --commit 恢复`; `--commit` restores it and continues with ` · 已恢复（已校验） · 撤销前状态另存 <name> · 缓存清理 N` (the **current** state is first saved aside as `<log>.before-undo-<timestamp>`). **The backup is validated before it is installed**: frames decodable, header legal, `seq` dense, references legal, no torn tail, and no fewer events than the current log; a backup that fails is refused **with the current log left untouched** — `拒绝恢复：备份 <name> 不合格（<reason>） · 当前日志未改动（185B） · 可改用更早的 .quarantine-* 或 .before-undo-* 备份手工恢复`. Refusing the current session: `拒绝恢复在用会话 sess-u（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact undo --session sess-u` |

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

1. **All whitespace is flattened**: `\n`, `\t`, and runs of spaces all become a single space — **multi-line text becomes one line here, always**.
2. **It is truncated at 200 display cells** with a trailing `…`. Width is measured in terminal cells, and **a CJK character counts as 2**, so a Chinese notification really only has room for ~100 characters.

This is a **hard constraint, not a style choice** — the renderer will not make an exception for a command that would like a few more rows. So the plugin now does the same thing to itself first: `index.js` carries a `clamp(s, 200)` with identical rules (CJK counts as 2, overflow ends in `…`), and the command registration wraps the whole handler in `clampResult()`:

```js
handler: (invocation) => clampResult(handler(invocation)),
```

In other words, **every output is already squeezed into 200 cells before it leaves the handler** — it never depends on the renderer to do the cutting. So every subcommand's normal output is now a **single line**, fields separated by ` · `, most important information first (only a few long error branches are still newline-joined internally — see below).

So use this tool on that assumption:

* **Do not expect readable multi-line formatting.** Anything past 200 cells is cut off, tail first. Even `apply` / `rollback` success lines can be cut off after the backup information, because quarantine file names are long. (That is also why the success wording now leads with the backup and its "still contains the original, delete it yourself" reminder.)
* **Do not plan around copying a long string out of a notification.** The notification has been flattened and truncated; a long path or line number may already be gone and is awkward to select anyway. This is exactly why `hide <index>` exists: after `/redact nodes`, hiding the newest entry is just `/redact hide 1 --commit` — **not one character copied from a notification**.
* `list` / `nodes` / `scan` deliberately show fewer entries than they could (`…另N个` / `…共M`): better to list less than to have a critical line number truncated away.
* A few long **error** branches (refusing to rewrite the current session, `未知子命令`, a missing plan file) are still newline-joined strings internally; they are `clamp`ed to 200 cells and flattened by the renderer just the same, so what you see on screen is always one line.

> [!TIP]
> **The one exception is `/redact pick`, and it exists precisely to escape this constraint.** Its dialog goes through the TUI's own panel (`ctx.tuiDialogs`), rendered in the TUI's chrome with the TUI owning the keyboard — it **never passes through `cleanRenderText`**, so it can be multi-line, arrow-key navigable, and neither flattened nor truncated. To pick from the complete list use `pick`; to locate something inside a single-line notification use `nodes` + `hide <序号>`. The two are complementary, and **neither ever shows the tool result's body** (index / line / turn / tool / size only, plus the command line inside `pick`). Note that `pick` is **off by default** (`allowDialogs: false`, see §2.5) — the exception only exists once you enable it.

Details, all taken from the implementation:

* **`rollback` and `undo` are dry runs by default** — they need an explicit `--commit` to write, as does `hide`. `rollback` / `undo`, like `apply`, **refuse to act on the session you are currently using** unless `--allow-live` is given; `hide` / `pick` are the exact opposite — **they only act on the current session**, error out when `--session` points elsewhere, and do not accept `--allow-live` at all.

* **`nodes` is paged; `nodes full` is an export.** It lists the **current session's** `tool/result` surface nodes, **newest first** (the one that just tripped a guardrail is almost always the latest). Paging splits on the **display-cell budget**, not a fixed item count — a fixed count would make "the few that no longer fit" permanently invisible — and indices stay continuous across pages, so an index seen on any page can be fed straight to `hide <序号>`. `nodes full` writes the complete list to `%TEMP%\dsh-redact-nodes-<session id>.txt` (the file name uses the **full** id so two sessions cannot overwrite each other), every row ending in `→ /redact hide <n> --commit`, with the command line truncated to `argsCells` (`0` = no command line at all). It **never shows the body**, and it does not expose the internal `seq` (`seq` appears only in `hide`'s dry-run and midway-failure wording; the listing file and the panel use the **index / line number**, because those are what you can feed back into a command).

* **`pick` is the right way to "see it all, then choose", but it is off by default and depends on the TUI row.** The gates run in this order: `allowDialogs` (default `false` → the "off by default" explanation) → `dialogTimeoutMs === 0` → `ctx.get('tuiDialogs')`. It soft-probes that service — by default deliberately **not in `inject`**, so a missing service never parks this plugin in a waiting state; `pick` simply returns the graceful-degradation message. The price is that in the worst startup order the panel can silently fail to open (the plugin turns a < 50 ms cancel into a dedicated error). **To actually use the panel you need `allowDialogs: true` plus the row-level `inject`** (see §2.5). The service contract lives in `@deepseek-harness-tui/dsh-tui`'s `lib/types/dsh-adapter/dialogs.d.ts`: `ctx.tuiDialogs` is a `TuiDialogRuntime extends Service` exposing `select` / `confirm` / `input`; every method **validates its request** (untrusted data on the render path) and, when the request is malformed, only **warns and resolves with the cancelled value** (`undefined` / `false`) — it **never throws**, because "a dialog must never take the plugin or the TUI down". The same file declares `DIALOG_DEFAULT_TIMEOUT_MS = 30000` (the fallback when neither `signal` nor `timeoutMs` is given); this plugin passes an explicit `timeoutMs: dialogTimeoutMs` to both dialogs (**default 15000**; the old 120000 is gone — see §2.3 and §2.5). `select` resolves the chosen `id` or `undefined` on cancel; `confirm` resolves a boolean, `false` on cancel — this plugin treats both as "cancelled", except that **a cancel in under 50 ms is not a human cancel**: it means the host did not admit this row (the admission race), and the plugin reports that separately (see §2.5). The runtime also bounds every request (`TITLE_CELLS` / `LABEL_CELLS` = 120 cells, `MESSAGE_CELLS` = 400, `MAX_OPTIONS` = 100), which is why the plugin keeps titles near 90 cells and caps options at 60 — so the host never silently trims away information you need.

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
* An unknown subcommand returns `未知子命令 <cmd>` plus usage; with neither an `agent` nor `--session` you get `无法确定目标会话，请加 --session <id>`. The usage string itself is one line too: `用法：/redact list|nodes|pick|verify|purge|undo（可加 --session <id>） · scan|plan|apply <计划.json> · hide <序号|计划.json|--lines 行号> · rollback <轮数> · 写操作需 --commit；匹配文本写在计划文件里，别写命令行`.

### 3.2 Identification metadata: telling *which* node is which

The most common complaint is "**I simply cannot tell which message needs retracting or editing**". So `nodes` / `nodes full` / `pick` now all carry the same identification metadata — **index / log line / turn / tool name / size / that call's command line**. The tool result's **body** never appears (that is this tool's promise), but those six fields together are enough to recognise the target.

Four real samples (all from synthetic fixtures, never a real session; samples 3 and 4 are the exception — `pick` only reaches the dialog once `allowDialogs: true` is set):

```
1) the /redact nodes one-line notification (newest first; each cell is [index] line 轮T tool size)
共 3 个 tool/result（最新在前）：[1] 7 轮3 tool-2 149B ｜ [2] 5 轮2 tool-1 149B ｜ [3] 3 轮1 tool-0 149B 全文 /redact nodes full · 隐藏 /redact hide <序号>

2) the listing file written by /redact nodes full (one row per node, ending in a copy-ready hide command)
[1] 轮 3  tool-2  149B  行 7  {"cmd":"very-long-command-line-2","query":"SYNTHETIC-SEARCH-TERM-…  → /redact hide 1 --commit
[2] 轮 2  tool-1  149B  行 5  {"cmd":"very-long-command-line-1","query":"SYNTHETIC-SEARCH-TERM-…  → /redact hide 2 --commit

3) a /redact pick option: the label carries the identification, the description carries the command line
[1] 行 7 轮 3 · tool-2 · 149B
{"cmd":"tool-2","q":"Q-2"}

4) the /redact pick confirmation panel (it reads the chosen node back to you)
隐藏 [2] 行 5 · tool-1 · 149B？
```

Where each field comes from (all inside `collectNodes()` in `index.js`):

| Field | Source | When unavailable |
|---|---|---|
| Index `[N]` | Position in `surface.nodes`, **newest first** — the very numbering `/redact hide <index>` uses | Always present |
| Line `<line>` | The `tool/result` event's `seq + 2` (row 1 is the header, so an event with `seq` N is log row N+2); this is what `--lines <line>` consumes | Always present |
| Turn `<T>` | The `tool/result` event's **own** `data.turn` — use it to line the entry up with the turn you see in the UI | Rendered as `-` |
| Tool name | `data.name` from the `tool/call` event found via `message.source.callId` | `(未知工具)` |
| Size | `JSON.stringify(event.data.message).length`, human-readable (`1.5KB` / `551B`) | `?` when serialisation fails |
| Command line | `data.arguments` of that same `tool/call` event (**only a string counts**; any other shape is treated as absent), flattened by `oneLine()`: control characters become spaces, whitespace is collapsed, then truncated to `argsCells` display cells | The segment is dropped entirely (`nodes full` leaves no placeholder, `pick` sets no `description`) |

How to use it: **read the turn first** to narrow down which round of the conversation it was, **then the command line** to confirm the action, **then the index** to act (`/redact hide <index> --commit`) — nothing to copy, and no original text dragged into your command history.

> [!TIP]
> **The command line is what makes an entry recognisable, but it can itself contain sensitive search terms** — hence `argsCells`: default `120` display cells, lower is more conservative, and `0` **shows no command line at all** (not even a `…` survives in the listing file or the panel). Note also that the **one-line `nodes` notification never contains a command line** (only index / line / turn / tool / size), so this switch only affects the `nodes full` file and `pick`'s `description`.

> [!NOTE]
> The turn comes from the `tool/result` event's **own** `data.turn`; only the tool name and the command line need a lookup in the `tool/call` event with the same `callId`. Also note the field order differs on purpose: a `nodes full` row is "turn first, line later" (`轮 3  tool-2  149B  行 7  …`) while the `nodes` notification is "line first, turn later" (`[1] 7 轮3 tool-2 149B`) — the notification's 200-cell budget is tighter, and the line number is the first-hand input for `--lines`, so it comes first.

### 3.3 The full `plan.json` schema

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

### 3.4 A worked `plan.json`

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

### 3.5 Offline CLI

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

The execution statistics for `plan` / `apply` / `cut` look like this (fields explained in §1 and §3.3):

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

### 3.6 Two recommended flows

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
/redact nodes                                     # 4. current session's tool/result list (newest first: index line turn tool size; command line via nodes full or pick)
/redact hide 1                                    # 5. dry-run hiding entry 1 (the newest) — 4 tokens, nothing to copy
/redact hide 1 --commit                           # 6. take it out of model view (next request, no restart)
/redact hide --lines 7 --commit                   #    or by log line number (7 is the number nodes printed)
/redact hide  C:\plans\plan.json --commit         #    or by the find in plan.json (dry-run first, then --commit)
/redact apply C:\plans\plan.json --session <id>   # 7. a session nobody is using: rewrite the bytes
/redact verify --session <id>                     # 8. re-verify
/redact purge  --session <id>                     # 9. purge caches (apply already did once)
/redact undo   --session <id>                     # 10. regret it: dry-run, then --commit to restore the backup
```

Steps 4–6 are **designed around the flattened notification**: `nodes` squeezes the index, line number, turn, tool name, and size into one line, and `hide <index>` needs nothing but a digit to point at a node (see the rendering constraint in §3.1). **To recognise "which one"**: match the turn against the round you see, confirm the action from the command line in `nodes full` or `pick`, then act on the index (see §3.2).

Note the division of labour: **`apply` on the current session is always refused** (see §4), so "the session I am sitting in" takes two steps — `hide --commit` first to stop the model seeing it right now (bytes still on disk), then the offline CLI once the session is closed (or `--allow-live` plus a restart) to remove the bytes. Conversely `hide` only accepts the current session: for any other session, go straight to `apply`. And if what you want to revoke is **whole turns** rather than a piece of text, use `rollback <turns>`; if it is **your own last redaction**, use `undo`.

---

## 4. Safety model

| Gate | Concrete behaviour |
|---|---|
| **Never prints content** | `/redact` and the CLI emit **line numbers and counts only**. `inspect --match` reports hit rows; `paths` reports paths, types, and lengths; even JSON parse errors are sanitised (keeping only `position N` and stripping the input snippet Node attaches) so an error message cannot leak the original text into the terminal or a log |
| **Quarantine backup before any in-place replacement** | In the TUI: `<log>.quarantine-<timestamp>` (ISO time with `:` and `.` replaced by `-`); same for CLI `--apply`. **The backup still contains the original** — delete it yourself once satisfied; the tool never does |
| **How it commits** | **Idle session**: write the quarantine backup → write `<log>.redact-tmp` → `fsync` → `rename` over the log. **Live session (`--allow-live`)**: write the quarantine backup → `open('r+')` → re-check the file revision before writing → **`ftruncate` first, then write** (an interruption leaves "a prefix of the old log" = the short tail the reader tolerates, not a "new head + old frames" hybrid) → verify the written byte count → `fsync`, an **in-place overwrite** — a rename could collide with an appending handle (especially on Windows), whereas the backend re-opens with `open(path,'a')` and writes at EOF for every batch, so an overwrite does not conflict with it |
| **The quarantine backup when a write fails** | If the target file was **not touched at all**, the backup just copied out is deleted (it is only a duplicate of the original); once the target has been touched the backup is kept and **named explicitly** in the error message (at that point it is the only complete copy of the original) |
| **Concurrent-append detection** | `apply` and `rollback` record the file revision (`size:mtimeMs:ctimeMs`) before reading and re-check it before committing; they check **once more** after `open` and before writing; and after writing they require the file length to equal the output length exactly. Any mismatch **refuses the whole run** (`未执行：日志在本次读取之后被追加过（可能有并发写入）`) rather than overwriting new events |
| **An extra gate under `--allow-live`** | For a live session, a **torn tail** causes an outright refusal: the write handle caches a "truncation offset computed for the pre-rewrite layout" and the next append would truncate by it, risking **silent corruption**. Close the session and retry |
| **`rollback` boundary protection** | Truncation happens only at a complete `turn/end` boundary, at least one turn must remain (a log with no `turn/end` is refused), and a cut that would remove an inherited `session/end-seed` marker (which the reader treats as corruption) is refused too |
| **`undo` validates before it installs atomically** | The chosen quarantine backup is validated first (frames decodable, header legal, `seq` dense, references legal, **no torn tail**, and no fewer events than the current log); a backup that fails is refused with a pointer to an older one. Installation uses "temp file + `rename`" rather than overwriting directly |
| **Refuses the live session** | If the target is the current session and `--allow-live` is absent, `apply` / `rollback` / `undo` all error out: the write handle still holds that log, so an in-place replacement could break subsequent appends. The message gives the safe alternative and notes that `--allow-live` requires reopening the session to reload history |
| **Self-check before writing (the master gate)** | Before output is produced it **decodes once more** and replays reader semantics: all JSON parses, the header is legal, **`seq` is dense**, and the **reference fields are legal** (`sourceEventSeqs` run-expansion rules: `end <` this row's `seq`, unique, strictly increasing when it carries a range; `surfaceOp` endpoints earlier; `session/title.messageSeqs` satisfying the real `dsh-session-title` invariant). Any failure aborts the output (`内部自检失败，已放弃输出`) — nothing is written rather than something broken |
| **The reference-field list is explicit** | `renumber` remaps only the references in the reader's own list (`surfaceOp`, `sourceEventSeqs`, `data.shadowedSeqs`, `data.shadowedRange`, `data.messageSeqs`, `data.sourceEventSeq`). An on-disk `sourceEventSeqs` `[start,end]` run is **expanded, mapped seq by seq, and recompressed with the same compressor**; any `*Seq` / `*Seqs` field outside that list **fails closed** (the run is refused) — better to refuse than to write a dangling reference |
| **Header and structural keys protected** | Row 1 can never be dropped, blanked, or rewritten; `type`/`seq`/`time`/`surfaceOp`/`sourceEventSeqs`/`toolCallId`/`callId`/`role`/`id` are never touched by `substitutions` or `blankLines`, and `setFields` refuses to write them |
| **Dialogs are off by default, because they yield the keyboard and may leave nobody able to answer** | `pick`'s modal dialog is **off by default** (`allowDialogs: false`): as soon as it becomes the **active request** in the TUI store, chat input yields the keyboard (`Chat.js`'s keyboard guard treats `dialogSnapshot !== null` exactly like the questionnaire / approval panels, `:698-701`, `:2562-2566`, and the prompt is disabled); and panel rendering is prioritised — **while an approval panel is up the dialog is not displayed yet stays pending** (`approvalPanelNode !== null` beats `dialogSnapshot` in the render branch, `:3585`), approval has **no timeout**, and `exitOnCtrlC: false` means `Ctrl+C` cannot exit either. So "press `pick` while an approval is pending" necessarily locks the keyboard until the timeout. The plugin therefore refuses to park the promise at all by default (it answers with a pointer to `nodes` + `hide <index>`); only with `allowDialogs: true` does it dial, with `timeoutMs` cut to **15000** (`dialogTimeoutMs` is configurable, `0` disables one more layer), and §2.5 explains how to keep the admission race from happening at all |

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
✓ <first 8 chars of id> · 帧 3 · 行 6 · 头部合法 · seq 密集 · 引用合法 · 读取端可打开
```

That one line is the whole output (see the rendering constraint in §3.1). When the check fails, the same place reports:

```
✗ <first 8 chars of id> · 帧 3 · 行 6 · 问题：<reason>
```

(`kind` is `error` too, so the notification is drawn in the error colour. `<reason>` is a **reader-semantics** verdict: a reference problem reports the reference check's own reason, otherwise you get the torn-tail offset / `seq` gap / parse-failure row count.)

This revision's `verify` checks one thing more than earlier ones: `refs = verifyLog(buf)` **replays the reference fields by reader semantics** (including the on-disk run form), which is why the pass line now carries `引用合法`. That closes the class of defects where the engine's own self-check was green while the real reader refused the log.

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

`verify` printing `· seq 密集 · 引用合法 · 读取端可打开` therefore means "these invariants hold and the reader can open the log". It does **not** prove the content is gone — confirm that with the step-3 hit re-scan.

### The self-tests in the repository

Five scripts, all using **synthetic logs only** (fake content; no real session is touched), covering different layers:

| Script | Assertions | Coverage |
|---|---|---|
| `test/handler.selftest.mjs` | 248 (the script prints its own `N/M 通过`) | **Plugin handler layer**: command registration metadata (including the hint string); the output and side effects of `list`/`nodes`/`pick`/`scan`/`hide`/`plan`/`apply`/`verify`/`purge`/`rollback`/`undo`; `--session` and `--allow-live`; every error path; `list`'s **single line inside the 200-cell budget** (including the `(当前)` marker, `…另N个`, and human-readable sizes); **`nodes` paging / cell budget / index continuity / out-of-range falling back to the last page / `--full` export / refusal of another session**; **identification metadata (every entry carries `轮 T`, reconciled one-for-one against the node ledger; each `nodes full` row carries turn / line / command line; `argsCells` in three states — default 120, custom, and `0` which shows nothing at all and leaves no placeholder; control characters collapsed to spaces)**; **`pick` (with `allowDialogs` at its default `false` it refuses and calls the dialog service **zero** times, and `nodes` does not advertise `pick`; once enabled it covers both paths with and without `tuiDialogs`, the request shapes for `select` and `confirm`, the < 50 ms criterion that separates a human cancel from a panel that never opened, a custom `dialogTimeoutMs` and `0`, invalid and non-numeric ids, a throwing dialog, the 60-entry cap, and no `description` at all under `argsCells=0`)**; **config validation (`null` / `undefined` / non-object / empty string / unknown key; `argsCells` and `dialogTimeoutMs` rejecting negatives, fractions, strings and `null`; `allowDialogs` rejecting every non-boolean)**; `hide` dry-run and `--commit` (asserting the `将隐藏 N 个节点` dry-run wording, the `surfaceOp`/`sourceEventSeqs` shape, that the body now carries the placeholder, and that **no disk bytes are deleted**); nested `blankLines`; cross-frame global substitution; suffix drops; middle drops; `renumber` reference remapping and dangling-reference refusal (asserting that a **`RedactError` is thrown**); header-frame byte preservation |
| `test/bugfix-regression.mjs` | 54 (the script prints its own `N/M 通过`) | **Regression guards** (fixtures are built with the **real `Session` + real codec**, and the verdict includes the **real `JsonlSessionPersistence.open()`**): the fixtures themselves must open in the real backend and `tool/result` must use the real message shape; an invalid plan and a middle-row drop return errors while the **process survives** (BUG-1 / BUG-1b); a damaged frame returns an error (BUG-2); `scan` locates without leaking text; `rollback` dry-run/execute/retention boundary/quarantine backup **and its output still opens**; `undo` find/execute/pre-undo snapshot/**restores something openable**/error when no backup exists; `apply` leaves an **openable log with an unchanged event count**; the refusal of all three on the current session; and the whole in-session hiding path (real message shape) |
| `test/hardening.mjs` | 78 (the script prints its own `N/M 通过`) | **The red-team findings F1–F10 regression suite**, judged by the real reader: the old fixture shape is rejected by the real backend (the meta-finding); `sourceEventSeqs` run expansion → remap → recompression and its "deleted from the middle of a range" refusal; `session/title.messageSeqs` remapping checked against the **real `dsh-session-title` invariant**; fail-closed handling of out-of-list `*Seq` fields; the master gate refusing anything the reader would reject; `undo` refusing truncated/corrupt backups and installing atomically; live-rewrite ordering/revision re-check/not swallowing concurrent appends; cache-purge failure not changing the command outcome; deleting or naming the quarantine backup on write failure; 20k-row `renumber` no longer blowing the stack; `hide` midway failure and unsupported message shapes |
| `test/preflight.mjs` | none (smoke) | Module imports; `name`/`inject`/`apply` shape; the command registers (prints the hint and `recordInput`); `list` runs; and the `hide` error text for an unknown session / unknown subcommand / missing plan file / no agent / a session with no surface |
| `session-surgery/selftest.mjs` | 34 (`34/34 通过`) | **Engine / CLI main path**: frame scanning and per-frame statistics; hit location that never echoes the text; `paths` printing no values; all three in-place rewrites while row count, frame count, and `seq` stay unchanged; untouched frames byte-for-byte; a middle-row drop refused without `renumber`; the same drop allowed with `renumber`; a suffix drop allowed; header drop/blank refused; rewriting the structural key `seq` refused; a corrupt file rejected; `verify` exiting cleanly; `plan` writing no files |

```sh
# inside dsh-plugin-redact/
node test/handler.selftest.mjs     # 248/248 通过 (exit code 0)
node test/bugfix-regression.mjs    # 54/54 通过 (exit code 0)
node test/hardening.mjs            # 78/78 通过 (exit code 0); needs a real DSH install (DSH_REDACT_DSH_LIB overrides the path)
node test/preflight.mjs            # smoke check, prints observations only

# the engine/CLI one lives next door
cd ../session-surgery
node selftest.mjs                  # 34/34 通过
```

The last two lines measured this round (`handler.selftest.mjs` prints **the tested file's** byte size and first 12 sha256 characters, so you can see which revision passed):

```
248/248 通过
被测 index.js：59330B sha256:e1b0ee081042
```

`bugfix-regression.mjs` and `hardening.mjs` take the **real DSH reader** as their judge: the former builds fixtures with the real `Session`/`sessionFormatCatalog` and re-checks them with the real `JsonlSessionPersistence.open()`, the latter additionally calls the real `dsh-session-title` invariant. **The engine's own self-check is not enough to catch reader-semantics defects** — the old fixtures wrote `role:'tool'` (the real shape is `role:'user'` + `source:{kind:'tool',callId}`), which is how a fully green suite once let both the `sourceEventSeqs` run defect and the `session/title.messageSeqs` defect through.

All five need **Node >= 22.15** (zstd APIs) and none requires DSH to be running. `handler.selftest.mjs` points `DSH_HOME` at a `mkdtemp` directory (fixtures are deleted afterwards) and prints **the byte size and first 12 sha256 characters of the tested `index.js`**, so you can see which revision passed; it also installs a safety net that turns `process.exit` into a throw — that path is no longer reached now that the engine throws `RedactError`, and the suite records the fact as one of its probes (see §6).

`test/real-reader.mjs` is listed as none of the five because it is **a helper module, not a suite**: it exports loaders and fixture tools for the real `Session` / `sessionFormatCatalog` / `JsonlSessionPersistence` (`writeSessionLog` / `backendOpen` / `titleInvariantError`) and is imported by `bugfix-regression.mjs` and `hardening.mjs`. Running `node test/real-reader.mjs` directly prints no assertions — that is its normal behaviour, not a failure. When it cannot find the real DSH packages it **throws rather than skipping** (the judge must not be downgraded); point `DSH_REDACT_DSH_LIB` at the `@deepseek-ai` directory to override the path.

Inside `test/`, **`handler.selftest.mjs` and `preflight.mjs` are in `package.json`'s `files` list** (they need no real DSH install, so they ship with the npm package and consumers can re-run them); `bugfix-regression.mjs`, `hardening.mjs` and `real-reader.mjs` are **repository-only** (their judge needs the real DSH reader and throws rather than skipping when it is missing). `package.json` declares no `scripts` — run them with `node <file>` directly.

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
14. `scan` honours `substitutions[].lines`: it reports only rows inside the restricted range, i.e. the rows `apply` would actually change, and says so with ` · 已按 substitutions[].lines 限定`. `verify` returns `日志无法解析：<reason>` for a log with a damaged frame header rather than throwing, but the offline `dsh-redact verify` is still the better check for such a file — it reports through exit code 2.
15. **`rollback` depends on `turn/end` events.** A log with no `turn/end` cannot be rolled back at all (it is refused), and at least one turn must remain — it cannot empty a session. A cut that would remove an inherited `session/end-seed` marker is refused as well.
16. **A notification is always one line and at most 200 display cells, and the plugin now trims to that budget itself.** The renderer (dsh-tui) flattens newlines and cuts at 200 cells — see §3.1 — and this plugin applies the same rule first via `clampResult()`, so every output is already ≤200 cells when it leaves the handler. This is a hard constraint, not a style choice: a CJK character costs 2 cells, so roughly 100 Chinese characters exhaust the budget. **The one exception is `/redact pick`**, whose dialogs go through the TUI's own panel and never pass through that render path — hence multi-line and arrow-key navigable, which is the whole point of it. Know the consequences: `apply` / `rollback` success lines carry a long quarantine file name, so their tail can be cut off; this revision moved the backup and the "still contains the original, delete it yourself" reminder to the front, but **never read a missing reminder as "there is no backup"** — the backup sits next to the log and `purge` / `undo` output names it. Likewise, with many sessions `list` can lose even its trailing `用 /redact nodes 看当前会话` hint, which is why `nodes` pages at all. **Do not design your workflow around copying a long string out of a notification**: to hide the newest node, just type `/redact hide 1 --commit`, or use `/redact pick`.
17. **`hide <index>` depends on an in-memory listing.** The index refers to **this session's most recent `/redact nodes`**, which lives only in the host process's memory, kept per session: without a prior `nodes` (or after a process restart) it reports `还没有节点列表，请先运行 /redact nodes`. If you would rather not depend on that, use `hide --lines <line>` (when you know the number), `hide <plan.json>`, or `pick` directly (it collects the nodes itself and does not use that listing).
18. **A few long error branches are still newline-joined internally.** Success paths and short errors are single-line, but "refusing to rewrite/truncate/restore the current session", "refusing `--allow-live` on a torn tail", "unknown subcommand", and "missing plan file" still build their text with `\n`. They too are `clamp`ed to 200 cells and then flattened by the renderer, so the screen still shows one line — the tail of a long sentence may simply be gone.
19. **`pick` is off by default and depends on the TUI row's dialog service.** The first gate is `allowDialogs` (**default `false`**): while it is off, `pick` returns `pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险` without touching any service, and every other subcommand is unaffected. Once enabled it soft-probes `ctx.get('tuiDialogs')` (**not in `inject` by default**, so a missing service never parks this plugin in a waiting state): without it, `pick` returns `当前前端没有对话框服务 tuiDialogs · 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`; with `dialogTimeoutMs: 0` it returns `对话框已被配置禁用（dialogTimeoutMs: 0）· …`. To really use the panel you need `allowDialogs: true` **and** the row-level `inject` (see §2.5); with only the former, the admission race makes `select` / `confirm` return the cancelled value within 50 ms — and the plugin reports exactly that case (`对话框没有弹出（0ms 内直接返回取消）…` / `确认框没有弹出（…）`) instead of failing silently. The service contract (`@deepseek-harness-tui/dsh-tui`'s `lib/types/dsh-adapter/dialogs.d.ts`) guarantees that a malformed request only produces a warning and the cancelled value, **never a throw**; this plugin passes `timeoutMs: dialogTimeoutMs` to both dialogs (default **15000**) and treats a timeout as "cancelled".
20. **`pick` can only select the newest 60 entries at a time.** That is the plugin's own cap (the host's `MAX_OPTIONS` is 100, so there is headroom): beyond it, `select.title` spells out `选择要隐藏的节点（共 70 个，仅列最新 60 个；其余用 /redact hide <序号>）`, but **the 61st node and older cannot be selected through the dialog at all** (`options` ids are `1..60` and always map to the **newest** 60). To handle those, page with `nodes <page>` and use `hide <序号>`, or export with `nodes full` and follow the indices in that file.
21. **The list file written by `nodes full` is never cleaned up automatically.** It lands in `%TEMP%\dsh-redact-nodes-<session id>.txt` (`$TMPDIR` on POSIX), its file name derived from the **full** session id, so different sessions do not overwrite each other. It contains **turn, tool name, size, log line number, and that call's command line** (the command line is governed by `argsCells`; `0` writes none) — **no tool-result bodies and no internal `seq`**; but the session id, tool names and command lines are still metadata (the command line may well hold search terms), so delete it yourself when done. This tool will not remove it, and does not clean up when the session ends.
22. **A dialog is the only output not bound by the 200-cell rule — and it is off by default.** Every other subcommand's output is `clamp()`ed to 200 display cells inside the handler (see §3.1), while `pick`'s dialogs are rendered in the TUI's own chrome and obey a different set of limits: title and option labels **120 cells** each, confirmation message **400 cells**, at most **100** options (`dialogs.js`'s `TITLE_CELLS` / `LABEL_CELLS` / `MESSAGE_CELLS` / `MAX_OPTIONS`). That is why the plugin keeps the select title near 90 cells, caps options at 60, and truncates the command line to `argsCells` — so the host never silently trims away the identification information you need. **This path is off by default too** (`allowDialogs: false`, see §2.5): while it is off, all you get is that one-line explanation, and the identification data still comes from `nodes` / `nodes full`.
23. **The identification fields are metadata too.** `nodes` / `nodes full` / `pick` display **turn, tool name, size, and the tool call's command line** (`argsCells` can switch the last one off). None of it is the tool result's body, but a command line may contain sensitive search terms — be more conservative by lowering `argsCells` or setting it to `0`.

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
   "files": ["index.js", "cordis.patch.yml", "cordis.patch.tui.yml", "lib/engine.mjs", "bin/dsh-redact.mjs", "test/handler.selftest.mjs", "test/preflight.mjs", "README.md", "README.zh.md", "LICENSE"]
   ```

   * `index.js` — the plugin entry (`export const name` / `export const inject` / `export function apply`)
   * `cordis.patch.yml` — the layer `dsh.bundle.patch` points at (the **default** layer: `inject: ['commands']` only and `allowDialogs` at its default `false`, so a non-TUI frontend still boots)
   * `cordis.patch.tui.yml` — the **TUI variant** layer: row-level `inject: [commands, tuiDialogs]` plus `allowDialogs: true` in the config (everything enabling `pick` needs; usage and cost in §2.5). `exports` resolves it as `dsh-plugin-redact/cordis.patch.tui.yml` too
   * `lib/engine.mjs` — the engine, imported relatively by `index.js`
   * `bin/dsh-redact.mjs` — the offline CLI (`bin.dsh-redact`)
   * `test/handler.selftest.mjs`, `test/preflight.mjs` — the two self-test scripts that need **no real DSH install**, published with the package (see §5)
   * both READMEs, and `LICENSE` (the **full MIT text; added this round** — it was missing from both `files` and the tarball before)

   `test/bugfix-regression.mjs`, `test/hardening.mjs` and the helper module `test/real-reader.mjs` are **deliberately repository-only, not in `files`**: they take the **real DSH reader** as their judge (they need `@deepseek-ai/*` installed locally) and throw rather than skip when it is absent, so shipping them to consumers would be pointless. Do **not** put test fixtures, `plan.json`, or `needle.txt` leftovers in the package (the self-test scripts only build synthetic fixtures under a `mkdtemp` directory, so the scripts themselves are safe to publish).
2. **Preview the tarball** to confirm nothing is missing and nothing private is included:

   ```sh
   npm pack --dry-run
   ```

   Measured this round (`dsh-plugin-redact@0.1.0`): **11 files, 137.0 kB packed / 398.1 kB unpacked**, the file list being `LICENSE`, both READMEs, `bin/dsh-redact.mjs`, `cordis.patch.tui.yml`, `cordis.patch.yml`, `index.js`, `lib/engine.mjs`, `package.json`, `test/handler.selftest.mjs`, `test/preflight.mjs`. The sibling package packed in the same batch, `dsh-plugin-content-policy@0.2.0`, is **10 files / 61.9 kB** — both packages now carry a `LICENSE`.
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

The offline CLI ships with the package (`bin.dsh-redact`); from the profile directory it is available as `npx dsh-redact`, or invoke its entry file directly. **On a dsh-tui frontend, and only if you want `/redact pick`'s panel**, apply the packaged `cordis.patch.tui.yml` as described in §2.5 after installing — it supplies both halves (the row-level `inject: [commands, tuiDialogs]` and `allowDialogs: true`). Without it everything still works: `pick` just answers with the "off by default" explanation and points you at `nodes` + `hide <index>`. On a non-TUI frontend, do **not** apply that layer (it would stop the whole profile from booting).

### 8.5 Three reminders when distributing

* **DSH has no official plugin registry.** The official docs document only npm / tarball / git distribution and state that publishing to a registry is not required; there is no official submission form or review step. Community directories (the cordis.run marketplace and its auto-generated Awesome list, the `dsh-plugin-verify` verification repository, dshfind.com / dsh.so, and the `dsh-tui-ecosystem` + `dsh-ecosystem-spec` admission spec) are **community-run with their own processes** and imply no official endorsement.
* **Third-party plugins run as trusted host code, outside the sandbox.** Installing one means executing its code with your machine's permissions, and it can read and write your session logs — which is exactly how this plugin works. Review it like any local program, and when publishing, state your permission needs plainly (the default layer `inject`s `commands` only; the TUI variant layer additionally declares `tuiDialogs` — see §2.5; neither publishes a service, makes network calls, or touches anything but the `root` / `cacheRoot` you configure).
* **Never put real sensitive content in a README.** Examples, issues, screenshots, and test fixtures linger in public records — which is the very reason this tool exists.

---

## 9. License

MIT.
