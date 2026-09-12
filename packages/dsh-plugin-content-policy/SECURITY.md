# Security — dsh-plugin-content-policy

Full document, including the audit method and the list of what these packages cannot do to you: <https://github.com/L-ingqin12/dsh-redaction/blob/main/SECURITY.md>.

## Reporting

Use a [private advisory](https://github.com/L-ingqin12/dsh-redaction/security/advisories/new). If the bug is that something **should have been stripped and was not**, say so plainly and describe its shape (which tool, which field) rather than pasting the content — a bug report is a permanent public record.

## This package is inert until you configure it

It ships `rules: []` and `strip: []`, which registers no tool listeners at all. Nothing about your tool results changes until you write rules of your own. There is no default blocklist and no built-in list of categories or domains — the built-in `stripDefaults` only drops `sources.*.snippet` and `content` from `web_search` output, structurally, without inspecting what they contain.

## What it cannot do

- **No filesystem writes.** The package contains no write, rename, unlink or mkdir call.
- **No install-time code.** The only lifecycle script is `prepublishOnly`, which never runs on your machine.
- **No `process.exit`** — it cannot terminate your DSH process.
- **No network capability at all** — no `node:http(s)`, `net`, `tls`, `dgram` or `dns`, and no `fetch`.
- **No `child_process`, no `eval`, no `new Function`.**
- **Cannot silently mangle a value.** If a rule would violate the tool's output schema — removing a `required` field, truncating an `enum` — the plugin refuses that rule and reports it rather than emitting an invalid value.

Requires **Node >= 22.15**.
