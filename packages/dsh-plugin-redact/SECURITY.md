# Security — dsh-plugin-redact

Full document, including the audit method and the list of what these packages cannot do to you: <https://github.com/L-ingqin12/dsh-redaction/blob/main/SECURITY.md>.

## Reporting

Use a [private advisory](https://github.com/L-ingqin12/dsh-redaction/security/advisories/new). If the bug is that this tool **failed to remove something**, say so plainly and describe its shape (which field, which row) rather than pasting the content — a bug report is a permanent public record.

## What this package does that scanners flag

It rewrites session logs. That is the product, so `fs.writeFileSync` against a log path is expected. Before any modification the original bytes are copied to a sibling `<log>.quarantine-<ISO timestamp>`, and the write path verifies the file's revision both before and after opening the handle, truncates to the target length before writing so an interruption leaves only a recoverable torn tail, re-checks the size afterwards, and deletes the backup when the target was never modified.

## What it cannot do

- **No install-time code.** The only lifecycle script is `prepublishOnly`, which never runs on your machine.
- **Cannot kill your DSH process.** The plugin imports eight pure functions from the engine and never reaches the CLI entry point; it contains zero `process.exit`. Those calls live on the offline CLI path in `bin/`, which runs in its own process.
- **Cannot throw on import.** Every top-level statement in `index.js` is a declaration, so importing it cannot abort your boot.
- **No network capability at all** — no `node:http(s)`, `net`, `tls`, `dgram` or `dns`, and no `fetch`. A tool that cannot open a socket cannot transmit what it removes.
- **No `child_process`, no `eval`, no `new Function`.**
- **Cannot be pointed outside your session directory.** The session id — the only externally supplied value that becomes a path — must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and the resolved path must stay under the configured root.

Requires **Node >= 22.15** for the zlib zstd API.
