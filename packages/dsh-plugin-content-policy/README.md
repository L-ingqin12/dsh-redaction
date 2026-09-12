# dsh-plugin-content-policy

A rule-driven **content policy for DeepSeek Harness tool results**: it inspects and rewrites what a tool is about to return, *before* that content is persisted into the session log and before it is sent to the model provider.

> 中文完整文档（字段表、接缝表、正确性对照、局限）：[README.zh.md](README.zh.md)。This file is a short English overview; the Chinese document is the complete reference.

## Why it exists

A session's `tool/result` event **is** the model-facing message — the agent loop rebuilds every request from the stored events. So one write has two consequences: the durable log and every future provider request. Anything you must not retain (secrets, legally sensitive material, or simply wrong retrieved text) therefore has to be handled *before* that write.

`@deepseek-ai/dsh-spill-policy` already bounds **plain-text** tool results by size — oversized output is spilled to a file and the model receives a head/tail preview. It explicitly leaves results containing non-text blocks untouched. This plugin covers that gap and adds pattern-based redaction.

## Two mechanisms

| | What it does | Config |
|---|---|---|
| **Rules** (`rules`) | Matches literal or regex patterns in tool-result content and replaces or blocks them | `rules: [{ id, match, action, replacement, tools }]` |
| **Stripping** (`strip`) | Drops or truncates whole optional fields of a *structured* result — e.g. `web_search`'s `sources[].snippet` and its generated `content` answer | `strip: [{ id, tool, path, maxChars? }]`, or `stripDefaults: true` |

Both run on the same `tools/execute` waterfall and rewrite the result **`value`**, not its `content`. That distinction matters: replacing only `content` leaves the raw text in the result's `meta`, which is persisted verbatim. Rewriting the value re-derives both `content` and `presentationMeta`, so the rendered text and the durable record are cleaned together.

Stripping is content-agnostic — it removes a payload without needing to know what is in it, which is the only workable defence for *unenumerable* content.

Order is **strip first, then rules**: a 200 KB snippet would otherwise consume the scan budget and cause the strip to be skipped.

## Install

```powershell
dsh plugin --profile <name> add dsh-plugin-content-policy
dsh --profile <name> --dump-config    # confirm the dsh-content-policy row appears
```

The shipped row is a **true no-op** (`rules: []`, `strip: []`): it registers no listeners until you configure something.

To enable the built-in `web_search` minimisation, override the row in your profile's `cordis.patch.yml` (a patch replaces the row's **whole** `config`, so write every field):

```yaml
- id: dsh-content-policy
  config:
    enabled: true
    rules: []
    strip: []
    stripDefaults: true
```

## Configuration summary

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `rules` | `[]` | Pattern rules: `{ id, match, action: 'replace'\|'block', replacement, tools }` |
| `strip` | `[]` | Field removals: `{ id, tool, path, maxChars? }`. No `maxChars` ⇒ drop the field entirely |
| `stripDefaults` | `false` | Prepend the built-in `web_search` rules (`sources.*.snippet`, `content`) |
| `onStripRefused` | `'error'` | What to do when a rule targets a **required** field: fail loudly, or `'skip'` |
| `maxScannedBytes` | `4194304` | Per-result scan budget; `Infinity` for unlimited |
| `onBudgetExceeded` | `'partial'` | Behaviour when the budget is exhausted |
| `onUnsafeValue` | `'keep'` | Behaviour when a value cannot be safely rewritten |
| `notify` | `true` | Whether the model/user is told something was redacted |

Numeric fields must be integers `>= 1` and are rejected **at config validation**, so a bad value is reported against the row that carries it rather than surfacing later.

### A note on the two config-validation tracks

The package validates its `Config` with `@deepseek-ai/schemastery` when that module is resolvable, and otherwise falls back to a built-in Standard Schema implementation with the same field table and defaults. In a normal install the plugin is reached through a symlink from the profile, so schemastery is **not** resolvable and the fallback is what actually runs. The two tracks have three known cosmetic divergences (nested-object defaults, unknown-key handling, error wording) and no behavioural divergence; `README.zh.md` §2.1 documents them precisely.

## What this cannot prevent

- **Tool-call arguments.** They are persisted before the tool body runs and cannot be rewritten; only the result is in scope.
- **Content already persisted.** Use a remediation tool for existing logs.
- **Content already sent** to a provider.
- **Other channels**: files a tool writes, spill temp files, subagent output, model output.
- **Unenumerable content** unless you use structural stripping or a block rule.

## Tests

```powershell
npm test    # test/selftest.mjs + test/harness.mjs — no DSH installation required
```

Two further suites (`test/registry-e2e.mjs`, `test/config-schemastery.mjs`) drive the real `dsh-tools` registry and the real schemastery track; they require a DSH installation and locate it from `DSH_HOME`, overridable with `DSH_NODE_MODULES`. They exit `3` (not `0`) when the installation is missing, so an unrun suite cannot masquerade as a pass.

Requires **Node >= 22.15** (the zlib zstd API).

## License

MIT
