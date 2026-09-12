# DSH third-party plugin survey — can any existing plugin REDACT / REWRITE / ROLL BACK stored session content, usable from a `dsh-tui` terminal frontend?

Research date: 2026-09-12. All web content treated as untrusted data.
Verification method: web_search + web_fetch of raw READMEs, npm registry metadata, GitHub REST API, and the official DSH source docs; plus read-only inspection of the local DSH install at `$DSH_HOME=%USERPROFILE%\.dsh` (DSH `0.1.5-rc.1`).

---

## 0. Ground truth established locally (this machine)

| Fact | Evidence |
|---|---|
| Installed DSH version | `dsh --version` → `0.1.5-rc.1` |
| Session logs are real files named `session.vN.jsonl.zstd` | `%USERPROFILE%\.dsh\sessions\<workspace-key>\<session-id>\session.v3.jsonl.zstd` (also legacy `session.jsonl.zstd`). 14 live logs observed, 31 KB – 1.5 MB. |
| A profile literally named `dsh-tui` exists | `%USERPROFILE%\.dsh\profiles\dsh-tui\package.json` |
| What that profile mounts | `bundles: ["@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui"]`, dependency `"@deepseek-harness-tui/dsh-tui": "^0.10.1"` |
| `dsh plugin` is a pnpm forwarder, not a bespoke installer | `dsh plugin --profile dsh-tui --help` printed **pnpm 11.22.0** help. Confirmed by official CLI reference: "`dsh plugin --profile <name> <args...>` … then forwards `<args...>` to `pnpm` with the profile directory as working directory" ([CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/apps/cli/reference/README.md)) |

⚠️ **Naming trap — "dsh-tui" is ambiguous across three different projects:**
1. `@deepseek-harness-tui/dsh-tui` (repo `ccch1mneyyy/dsh-TUI`) — **this is the frontend actually installed on this machine**, MIT, public beta ([npm](https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui), [local README](%USERPROFILE%\.dsh\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui\README.md)).
2. `github:deepseek-harness/turtle-ui` — the TUI the *official* CLI reference uses as its example, published as `@dsh-tui/dsh-tui` on npm ("Interactive pi-tui terminal front door").
3. `orriduck/dsh-tui`, `gxinxing/deepseek-harness-tui`, `@openguardrails/dsh-tui`, `@huiliyi37/dsh-tianshu-tui`, `dsh-cc-tui` — other, unrelated TUI frontends listed in the awesome list.

Everything below about "the TUI" refers to #1, the one in this profile.

---

## (a) Landscape table

### A1. Plugins that touch conversation content / history (the core question)

| Plugin | npm package | Repo | License | Last update | What it mechanically does | Frontend | Content redaction? | Undo the redaction? |
|---|---|---|---|---|---|---|---|---|
| **dsh-easyrewrite** | `dsh-easyrewrite` | [Renzic-Stone/DSH-EasyRewrite](https://github.com/Renzic-Stone/DSH-EasyRewrite) | MIT | pushed 2026-09-09 (106★) | Archives the original session and substitutes a **same-named new session truncated before the target message**, then auto-sends the edited text. Uses official fork RPC; lazy commit. | **DSH Web only** (keyed slot overrides + client RPC) | ❌ Original log is *archived*, not erased. No substring/tool-result scrubbing. | Version pager `‹ X/N ›` + archived versions restorable from settings |
| **dsh-conversation-rewind** | *(unpublished — tarball URL install)* | [DTSFO/dsh-conversation-rewind](https://github.com/DTSFO/dsh-conversation-rewind) | MIT | pushed 2026-08-16 (1★) | Appends a DSH `SurfaceOp` **replacement marker** so the selected message + its reply + later path are hidden from the transcript *and future model context*. | **DSH Web only** — "This release targets the DSH Web UI and DSH `0.1.0-rc.6` APIs." | ⚠️ **Partial** — removed from model context, *not* from disk | ✅ Branch tree browsing + can edit again |
| **dsh-message-edit** | `dsh-message-edit` | [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) | ⚠️ **none declared** (`license: null` in GitHub API) | pushed 2026-08-16 (49★, 20 open issues) | Each edit/reroll/retry **creates a new session version** seeded via `ctx.agents.create({seed, meta})`; old sessions retained. | **DSH Web only** (`conversation.view` Timeline slot) | ❌ "不原地改写 Session 事件；历史是 append-only、deep-frozen" | ✅ Switch between session versions |
| **dsh-undo** | `dsh-undo` | [LingLambda/dsh-undo](https://github.com/LingLambda/dsh-undo) | MIT | pushed 2026-08-15 (4★) | `/undo` appends a durable `surface/rewind` control event; `/redo` appends `surface/restore`. "Harness sessions remain append-only… The original message nodes, message IDs, tool-call correlations, and log events are retained." | Host command + **WebUI** bubble action | ❌ Nothing removed from disk | ✅ `/redo`, LIFO |
| **dsh-session-cleaner** | *(unpublished)* | [haoranwang0921/dsh-session-cleaner](https://github.com/haoranwang0921/dsh-session-cleaner) | **Apache-2.0** | pushed 2026-09-05 (6★) | Whole session: archives and **physically deletes the persisted JSONL log directory** (plus message-feedback data). Single message: **surface replace**, i.e. removed from model context — "但原始事件仍保留在日志与人类转录中". | **DSH Web GUI** (dual-face: node half + `dsh.client` browser half; Settings → 会话管理) | ⚠️ **Partial / closest match** — whole-session deletion removes bytes; message-level does not | ❌ "删除操作不可逆" (irreversible). No backup. |
| **dsh-sess** | `dsh-sess` | [youridol/dsh-sess](https://github.com/youridol/dsh-sess) | MIT | targets `dsh-v0.1.2-alpha.5` | **Permanently deletes cold sessions** (log artifact + workspace accounting) via `ctx.sessionPersistence.locate()`. No message-level operation. | **Web UI only** — "targets the **web** UI … it does not change headless/CLI behavior." | ⚠️ Whole-session only | ❌ No; also **no unarchive** |
| **@anionex/dsh-turn-rewind** | `@anionex/dsh-turn-rewind` | [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) | BSD-3-Clause | recent (0.3.8 line) | Restores **project files** from a Change Ledger; "Rewind messages only" **forks a new Session ending before the message**. | Web profile (dialog) + headless | ❌ | ✅ Rescue points |
| **dsh-shadow-rewind** | `dsh-shadow-rewind` (0.9.2) | [DreamsTOF/dsh-shadow-rewind](https://github.com/DreamsTOF/dsh-shadow-rewind) | MIT | npm published 2026-09-01 | Per-turn **workspace file** snapshots into a hidden shadow jj repo; restore files, optionally fork a new session. | **`dsh.client.platform: "web"`**, needs `dsh-better-sidebar` | ❌ | ✅ Rescue points + operation journal |
| **dsh-secret-redactor** | *(unpublished, git-only)* | [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins) → `packages/dsh-secret-redactor` | ⚠️ **no LICENSE file** on repo (`license: null`); `package.json` says MIT | pushed 2026-08-15 (1★, 2 open issues) | Hooks **`tools/post-execute` waterfall**, masks 25 secret patterns in the text blocks the model sees. Host-only, no `dsh.client`. | **Frontend-agnostic (host half)** — install example is `--profile web add` but nothing binds it to Web | ❌ **Explicitly not on disk**: "The durable log still stores the raw canonical result value; **full log-level redaction is on the roadmap**." | n/a (non-destructive) |
| **dsh-telemetry-redactor** | `dsh-telemetry-redactor` | [030611/dsh-telemetry-redactor](https://github.com/030611/dsh-telemetry-redactor) | MIT | pushed 2026-08-14 (2★) | Hooks `session-telemetry/record` waterfall; redacts the **outbound telemetry copy**. | Host plugin (profile-agnostic) | ❌ — "it changes only the outbound copy: **it never rewrites the canonical session log**" | n/a |
| **dsh-plugin-edit-review** | *(unpublished)* | [chuichao/dsh-plugin-edit-review](https://github.com/chuichao/dsh-plugin-edit-review) | MIT | pushed 2026-09-04 (1★) | **Not conversation content.** Ledgers AI `write`/`edit` **file** results and writes back pre-edit file snapshots. | Browser diff tab; manual `pnpm` + `cordis.patch.yml` install | ❌ (files, not history) | ✅ revert |
| **dsh-plugin-marketplace** | `dsh-plugin-marketplace` | [Scorp1o117/dsh-plugin-marketplace](https://github.com/Scorp1o117/dsh-plugin-marketplace) | MIT | pushed 2026-09-10 (2★) | Browses `github.com/topics/dsh-plugin` via GitHub search API inside the Web settings page. Not a history editor. | **DSH Web UI** (`settings.section` slot) | ❌ | n/a |

### A2. Everything else in the Awesome list / marketplace whose description touches history, undo/rewind, redaction, recall, log manipulation, or TUI

Source: [web-casa/Awesome-DeepSeek-Harness-Plugins](https://github.com/web-casa/Awesome-DeepSeek-Harness-Plugins) — 331 plugins, auto-generated from the cordis.run index, list licensed CC0-1.0, last pushed 2026-08-31. Only the entries that match the brief are listed; the other ~300 are unrelated (tools, themes, providers, notifications).

| Plugin | One-line description (as listed) | Why it's in scope | Redacts stored content? |
|---|---|---|---|
| `dsh-recall` ([Mongfayi](https://github.com/Mongfayi/dsh-recall)) | Conversation history recall: search the original text of every session | history read | ❌ read-only |
| `dsh-session-index` ([longyu065](https://github.com/longyu065/dsh-session-index)) | Full-text cross-session index; `ctx.sessionQuery` SQLite FTS5 | history read | ❌ |
| `dsh-payload-capture` ([Moeblack](https://github.com/Moeblack/dsh-payload-capture)) | Captures every outbound API payload to JSON | log/capture | ❌ adds copies |
| `dsh-record-replay` ([humblebanana](https://github.com/humblebanana/dsh-record-replay)) | Replay every recorded session as a timeline; export | replay/export | ❌ |
| `@deepseek-ai/dsh-session-health` ([omdsh-dev](https://github.com/omdsh-dev/dsh-session-health)) | Frame-level diagnostics over **multi-frame zstd session logs** (torn/corrupt/empty) | session-log manipulation (read-only) | ❌ |
| `@jorinyang/dsh-doctor` ([jorinyang](https://github.com/jorinyang/dsh-doctor)) | Diagnostic, repair and **rollback** plugin | "rollback" (config/plugin state, not content) | ❌ unverified scope |
| `dsh-archive-manager` ([zimixvx](https://github.com/zimixvx/dsh-archive-manager)) | Archived-session manager: restore/delete with full agent teardown | session deletion (Web) | ⚠️ whole session |
| `dsh-archived-sessions` ([hashdiana](https://github.com/hashdiana/dsh-archived-sessions)) | Lists archived sessions in settings | archive view | ❌ |
| `@dsh-external/dsh-archive-viewer` ([keepermttl](https://github.com/keepermttl/dsh-archive-viewer)) | View archived sessions: content search, read conversation logs, ZIP export | history read | ❌ |
| `dsh-side-panel` ([XYZ1024-alt](https://github.com/XYZ1024-alt/dsh-side-panel)) | Right-side panel: files, **session history**, git | history view | ❌ |
| `dsh-turn-index`, `@deepseek-ai/dsh-turn-navigator`, `dsh-milestone`, `@smanx/dsh-conversation-indicator`, `@vlln/dsh-navbar` | Turn/message navigation jumps | navigation only | ❌ |
| `dsh-plugin-context-compressor` ([YYTbit](https://github.com/YYTbit/dsh-plugin-context-compressor)) | "Intelligent conversation summarization" skill | context shaping | ❌ |
| `@loserfox/distill` ([LoserFox](https://github.com/LoserFox/distill)) | Automatic conversation reflection and skill distillation | history read | ❌ |
| `dsh-session-plugin` ([Heeweelee](https://github.com/Heeweelee/dsh-session-plugin)) | Input-box history recall (Up/Down) + right-click archive | history recall | ❌ |
| `kittimzhe/dsh-session-export` | `/transcript` writes Markdown/JSON via `ctx.sessionQuery` | export | ❌ |
| **TUI frontends (not plugins-with-commands)** | `dsh-cc-tui`, `@openguardrails/dsh-tui`, `@deepseek-ai/dsh-tui` (→ turtle1999/turtle-ui), `deepseek-harness-tui`, `dsh-tui` (orriduck), `@huiliyi37/dsh-tianshu-tui`, `@oh-dsh/desktop` | alternative TUI surfaces | ❌ |

**Not found anywhere in the index (331 plugins) or in targeted searches:** any plugin that edits, scrubs, or rewrites the persisted `session.vN.jsonl.zstd` content in place.

---

## (b) Verdict

### ❌ No off-the-shelf plugin provides terminal-TUI content redaction of stored session history.

Not partially — **not at all**, on any of the three required axes simultaneously.

**What exists, and exactly where each one stops:**

| Requirement | Closest existing thing | Where it stops |
|---|---|---|
| Removes specific text/tool results from disk | `dsh-session-cleaner` deletes the **whole** session log directory | Message-granularity deletes only do surface-replace: *"原始事件仍保留在日志与人类转录中"* |
| Removes content from what is sent to the model | `dsh-session-cleaner` (surface replace), `dsh-conversation-rewind` (SurfaceOp replacement), `dsh-secret-redactor` (tool-result masking) | All keep the raw bytes on disk; the redactor says so explicitly |
| Usable from the TUI | Nothing. Every history-mutating plugin is Web-only. | `dsh-conversation-rewind`: "targets the DSH Web UI"; `dsh-sess`: "does not change headless/CLI behavior"; `dsh-shadow-rewind`: `platform: "web"`; `dsh-easyrewrite`, `dsh-message-edit`, `dsh-session-cleaner`, `dsh-plugin-edit-review`, `dsh-plugin-marketplace`: Web client slots |
| Undo/backup of the redaction | `dsh-undo` `/redo`, `dsh-turn-rewind`/`dsh-shadow-rewind` rescue points | These undo *file* restores or *context* rewinds — none snapshots a redacted log so it can be un-redacted |

**The gap, stated precisely:** there is no plugin that (1) opens `$DSH_HOME/sessions/<ws>/<id>/session.vN.jsonl.zstd`, (2) rewrites or drops a specific event/message/tool-result payload while keeping the log replayable, (3) does so from a TUI surface, and (4) keeps a restorable backup of the pre-redaction log.

**What the TUI already gives you natively (and why it is not redaction):**
`dsh-TUI` ships a built-in **`/rewind`** (empty composer + double-`Esc`) ([docs/interaction.md](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/main/docs/interaction.md)):

> 1. 找到该消息所属 turn 的开始事件。 2. **通过 DSH session fork 创建分支会话。** 3. 回放该边界前的历史。 4. 把原消息放回输入框供修改和重发。
> - 边界取该消息所属回合**开始之前**；**不能回退到第一条消息**。

That is a **fork/branch**, not a truncation — the original `session.vN.jsonl.zstd` is retained on disk. The same page documents the real extension seam a redaction plugin would target:

> 插件可以介入这一步（`tui/rewind-prompt` 决策事件）：否决此次回退（给出原因），或在确认页提供额外的回退模式……回退完成时插件会收到 `tui/rewind-done` 通知

Also useful: the TUI's command menu = local commands **merged with the DSH command registry** ("注册表 | `/plan`、`/goal`，以及当前 DSH 组合注册的其他命令"), so a host-side plugin that registers a slash command via `@deepseek-ai/dsh-commands` *does* surface in the TUI. Plugin seams on this TUI: `tuiShortcuts`, `tuiStatus.registerView` (≤3 lines), `tuiToast`, managed dialogs, `settings-section`, `scenes`, item renderers — see the [admission & development spec](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) and [dsh-tui-ecosystem/plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template).

**Two host-side building blocks that would work in the TUI today, if you build the plugin yourself:**
- `dsh-secret-redactor`'s `tools/post-execute` waterfall hook — proven to load and mask, host-side, no client bundle; but its README concedes it does not touch the durable log.
- `dsh-session-cleaner`'s node half — proves the "surface replace" primitive exists and is usable from a host route.

**Risk notes / ⚠️ markers found:**
- `dsh-undo` opens with a **`> [!WARNING]`**: *"Forward-looking preview: this release is not usable with any currently published DeepSeek Harness version. It depends on unreleased Harness support for durable `surface/rewind` / `surface/restore` events… Installing it today will make `/undo` fail closed with an upgrade message."* **Unverified** whether DSH `0.1.5-rc.1` now satisfies this — the README's own text says no.
- `dsh-session-cleaner`: *"删除操作不可逆。请在操作前确认目标会话/消息；作者不对数据丢失负责。"* No backup, no undo.
- `dsh-sess`: deleting a *renamed* session "makes it live again" because rename resolves/resumes it; sidebar row-menu injection is DOM-level and "a future ui-workspace redesign may drop the entry".
- `dsh-plugin-marketplace`: two entries with the same loader id abort boot with `duplicate loader entry id: plugin-marketplace`; version-gated (`≥0.1.0-rc.7` for ≥0.2.8, pin `0.2.6` on rc.6, `0.3.1` for `0.1.2-rc.1` settings-RPC change).
- **No report of any of these plugins corrupting sessions was found.** The append-only design (every plugin above explicitly preserves the log) is the ecosystem norm; corruption reports were simply not surfaced in the sources reviewed. Mark as **not found / unverified**, not as "confirmed safe".

---

## (c) Publishing recipe — official plugin development & publishing process

Primary sources: official DSH docs [`docs/user/develop/basic/publish.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/publish.md) and [`apps/cli/reference/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/apps/cli/reference/README.md), distilled by [sandbaseai/deepseek-harness-handbook `docs/en/plugin-development/first-plugin.md`](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/en/plugin-development/first-plugin.md) (`verified_at: 2026-08-28`).

> ⚠️ The handbook's `docs/en/plugin-development/` directory exists but the publishing contract lives in **`first-plugin.md`** plus the official `publish.md`. The handbook's own link `https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish/` **404s**.

### C1. The two concepts

- A **bundle** is the npm package you ship; its manifest declares `dsh.bundle`, answering "what does this package contribute?" — a patch file that inserts/overrides plugin rows.
- A **profile** is a runnable composition at `$DSH_HOME/profiles/<name>`; its manifest declares `dsh.profile` and an ordered `bundles` list. **You never write a profile manifest by hand** — `dsh plugin` creates and maintains it.

### C2. Required files & exact snippets

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

`package.json` (official `publish.md`, verbatim):

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`index.js` — **required export shape of a plugin entry module** (official `publish.md`, verbatim):

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

With services/config (handbook `first-plugin.md`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string }
export const Config: Schema<Config> = Schema.object({ greeting: Schema.string().default('Hello') })

export const name = 'greet-tool'
export const inject = ['tools']            // hard service dependency, not documentation
export function apply(ctx: Context, config: Config) { /* register tools etc. */ }
```

> Handbook warning: *"a plugin exported as an object with a plain `function apply()` is treated as constructible… a returned disposer is not collected and a returned Promise is not awaited"* ([discussion #4455](https://github.com/deepseek-ai/deepseek-harness/discussions/4455)) — keep `apply` synchronous and register cleanup via `ctx.effect()`. This is a **community field report**, not confirmed for every release.

`cordis.patch.yml` (official `publish.md`, verbatim — note rows reference the package **by name**, not by path):

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

Browser half (only for a Web-UI plugin — **not** applicable to a TUI-only plugin): declare `dsh.client: { platform: "web" }` plus `exports["./client"] → ./client.js`; observed in `dsh-shadow-rewind`, `dsh-session-cleaner`, `dsh-plugin-marketplace`.

### C3. Exact `dsh plugin` CLI invocation

```sh
# install (first use initializes the profile, with @deepseek-ai/dsh-base as its first bundle)
dsh plugin --profile demo add ./hello-plugin
dsh plugin --profile demo add dsh-hello-plugin            # from npm
dsh plugin --profile demo add github:you/hello-plugin#<sha>   # from git, commit-pinned

# verify the layer WITHOUT booting
dsh --profile demo --dump-config        # adds profile + home patch + --patch overlays
dsh --profile demo --dump-default-config  # bundle layers only

# boot / remove
dsh --profile demo
dsh plugin --profile demo remove dsh-hello-plugin
```

`dsh plugin --profile <name> <args...>` initializes the profile when missing, then **forwards `<args...>` to `pnpm`** in the profile directory — so `add`, `remove`, `why`, `update` and every pnpm verb work unchanged, and **pnpm must be on PATH**. Relative path specs are anchored to the invoking directory first. After every successful run, `dsh.profile.bundles` is reconciled against the installed state.

**Effective layer order** (later layers win **per row**; a patch replaces the row's entire `config`, it does not deep-merge):

1. each bundle patch in `dsh.profile.bundles` order (`@deepseek-ai/dsh-base` first)
2. the profile's own `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. each `--patch <path>` overlay in argv order

`--dump-config` must show the inserted row before you boot. **Restart the profile after changing bundle membership** (ordinary `cordis.patch.yml` edits hot-reload in a `patchReload: live` profile).

### C4. Publishing to npm — conventions and constraints

Three supported distribution paths, per official `publish.md`:

| Distribution | Consumer behavior | Author responsibility |
|---|---|---|
| npm package | installs prebuilt artifacts | build before publish; include runtime files |
| packed tarball (`pnpm pack`) | installs a local immutable file | inspect `pnpm pack` contents, checksum it |
| Git dependency | fetches **sources**, may run `prepare` | self-contained `prepare`; document the exact commit |

- **`peerDependencies`** — the observed mandatory peer across every published DSH plugin inspected is **`@deepseek-ai/cordis`** (`^4.0.1` in `dsh-shadow-rewind@0.9.2`, `@dsh-tui/dsh-tui@0.1.2`, `dsh-secret-redactor`). Real plugins also pin the DSH runtime surface (`@deepseek-ai/dsh-agent`, `-session`, `-tools`, `-commands`, `-session-persistence`, …) at `>=0.1.0-rc.N <0.2.0` or `^0.1.0-rc.N`. ⚠️ **The official `publish.md` does not itself state a peerDependency requirement** — this is an observed convention, not a documented rule. Marked **unverified as a hard requirement**.
- **Naming/scope** — no scope is mandated in the official docs. Conventional third-party names are unscoped `dsh-*` (e.g. `dsh-easyrewrite`, `dsh-shadow-rewind`, `dsh-telemetry-redactor`) or owner-scoped `@owner/dsh-*`. ⚠️ **Unverified:** availability of the `@deepseek-ai` npm scope to third parties (all `@deepseek-ai/*` packages seen resolve to official or official-adjacent publishers). Do not assume you can publish under it.
- **Git installs need `allowBuilds`** — pnpm ≥10 refuses to run a git dependency's `prepare` until the *consumer* allowlists it. The first `add` fails; copy the exact key pnpm printed into the profile's `pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

  Official docs call this *"permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under."* Publishing to npm with `lib/` prebuilt at `pnpm publish` time avoids it entirely.

### C5. Is there an official registry / marketplace submission step?

**No.** The official `publish.md` documents only npm / tarball / git and states plainly: *"Publishing to a registry is not required."* No official DSH plugin registry, submission form, or approval step appears in the official CLI reference or the publishing tutorial.

Third-party directories are **community-run and independent**, each with its own submission flow:

| Directory | Submission mechanism | Status |
|---|---|---|
| [cordis.run](https://cordis.run) — powers the Awesome list | [cordis.run/submit](https://cordis.run/submit) | Community; claims per-plugin security scan. ⚠️ "official, auto-generated list" is the *list's* self-description — the marketplace itself is **not** an official DeepSeek property (unverified either way) |
| Verified DSH Plugins (`dsh-plugin-verify`) | PR adding `submissions/<owner>/<plugin>/{manifest,self_check,verify-report}.json`; must pass `npx dsh-plugin-verify <path> --repo <checkout>` showing `✅ 通过 \| waterfall: 7/7 \| tools/result: 是` | Community, runtime-verified |
| dshfind.com, dsh.so | badges/catalogues seen in READMEs | Community, indexing only |
| `dsh-tui-ecosystem` + [dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | admission spec + `plugin-template` repo | **This is the correct venue for a TUI plugin** |

### C6. Acceptance checklist (official, abridged)

- [ ] package contains its built entry point and the patch file; `dsh.bundle.patch` resolves inside the installed package
- [ ] `--dump-config` shows the expected bundle and row before boot
- [ ] every hard service dependency appears in `inject`
- [ ] external resources have a lifecycle disposer (`ctx.effect()`)
- [ ] a clean profile boots and invokes the tool
- [ ] removal deletes both the dependency and the composition layer
- [ ] git installs are commit-pinned and build permission is explicit

---

## Explicitly unverified / not established

1. Whether `dsh-undo` works on DSH `0.1.5-rc.1` — its README declares it unusable on *any* published version; I did not test it.
2. Whether `@deepseek-ai` npm scope is obtainable by third parties.
3. Whether `peerDependencies: @deepseek-ai/cordis` is a *documented* hard requirement (it is a universal observed convention).
4. The "last update" dates for `dsh-turn-rewind`, `dsh-sess`, `dsh-session-export`, `dsh-recall` — npm/GitHub timestamps not individually fetched for all of them.
5. Whether the `cordis.run` marketplace has any official DeepSeek affiliation.
6. Whether session logs are frame-compressed such that a *partial* rewrite preserves replayability — no source reviewed specifies the framing contract; `@deepseek-ai/dsh-session-health` proves multi-frame zstd with torn/corrupt detection exists, which suggests naive rewriting is unsafe. **This is the main technical risk for anyone building the missing plugin.**
7. No corruption reports for any plugin were found — which is *absence of evidence*, not evidence of safety.
