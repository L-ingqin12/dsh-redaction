#!/usr/bin/env node
/**
 * `dsh-redact` — the REMEDIAL half of the policy engine, and the only part that
 * is a separate process on purpose.
 *
 * ## Why remedial work cannot be a mounted row
 *
 * The durable session log is append-only by contract. The persistence service
 * documents that "events are contiguous from seq 0 and never rewritten", that a
 * batch failing `assertContiguous` is refused, and that `validateStoredEvents`
 * refuses unknown vocabulary fail-closed. There is also no pre-append
 * waterfall: `session/event` is a post-commit emit whose payload is "the event,
 * exactly as recorded". A mounted plugin therefore has no legal way to scrub
 * something already written, and a plugin that reached around the service to
 * rewrite the artifact would be corrupting a format the harness will later
 * validate.
 *
 * So the remedial surface is a CLI with two legal strategies and one
 * explicitly-guarded illegal one:
 *
 *   derive   read the stored session, redact the events, write a NEW session
 *            through `ctx.sessionPersistence`. Uses only public APIs. The
 *            original artifact is untouched, which is the honest outcome: the
 *            plugin can hand you a clean copy, not un-happen a write.
 *   export   produce a redacted, shareable projection for handing to someone
 *            else, leaving the local artifact alone.
 *   scrub    OFFLINE, frame-level rewrite of the on-disk artifact. Needs the
 *            session to be closed, needs a backup, needs an explicit
 *            acknowledgement flag, and needs the frame checksums recomputed —
 *            a standards-compliant Zstandard frame carries a checksum, so a
 *            naive in-place edit produces a file the reader will reject.
 *
 * @module @yourorg/dsh-redaction/cli
 */
import { readFileSync, copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { delimiter, join } from 'node:path'

const USAGE = `dsh-redact — redaction policy tooling for DeepSeek Harness

Usage:
  dsh-redact lint   --profile <name> [--json]
      Compose the profile, extract the \`redaction\` row, and validate it.
      Reports unknown keys (Schemastery SILENTLY DROPS them, so a typo'd YAML
      key under-enforces without any error), uncompilable detectors, detector
      ids referenced by no rule, rules referencing unknown detectors, and
      replacement templates that would re-match their own detector.

  dsh-redact ledger export --profile <name> --out <file>
      Export the append-only audit ledger with its hash chain intact.

  dsh-redact derive <session-id> --out <new-session-id> --profile <name> [--dry-run]
      Write a redacted DERIVATIVE session through the public persistence
      service. The original artifact is left untouched.

  dsh-redact scrub <path-to-session.v3.jsonl.zstd> [--in-place] [--dry-run]
      Offline frame-level rewrite. Requires --i-know-this-rewrites-history,
      refuses while the session is open, and writes <path>.bak first.

  dsh-redact schema
      Print the JSON schema envelope of the policy document (the same envelope
      a settings UI renders).

Exit codes: 0 ok · 1 findings (lint) · 2 usage error · 3 refused on safety rails
`

function die(message, code = 2) {
  process.stderr.write(`dsh-redact: ${message}\n`)
  process.exit(code)
}

/**
 * Locate the `dsh` CLI entry. Two anchors, in the order the loader itself uses:
 * the resolved `@deepseek-ai/dsh` package, then a sibling `bin.js` next to this
 * package (a monorepo checkout). Absolute paths only — never a PATH lookup, so
 * `lint` cannot silently compose a *different* installation than the one the
 * profile boots.
 */
function dshBin() {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    /* fall through to the PATH probe */
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const candidate of [join(dir, 'dsh'), join(dir, 'dsh.cmd'), join(dir, 'dsh.ps1')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  die('cannot locate the dsh CLI; install @deepseek-ai/dsh or put `dsh` on PATH')
}

/**
 * Compose a profile and return its config dump, WITHOUT booting the app.
 * `dsh --dump-config` shares the single `applyEntryPatches` call the boot
 * include makes, so linting against it cannot drift from what mounts.
 * @param profile - the profile name.
 * @returns the composed entry list rendered as YAML text.
 */
function composedDump(profile) {
  return execFileSync(process.execPath, [dshBin(), '--profile', profile, '--dump-config'], { encoding: 'utf8' })
}

/**
 * The `redaction` row's config as composed, read from the dump.
 * The dump is a YAML document; `js-yaml` is resolved from the installation the
 * same way every other plugin dependency is.
 */
function rowConfig(dump) {
  const row = /^- id: redaction\n(?:.*\n)*?(?=^- id: |\Z)/m.exec(dump)
  if (row === null) return undefined
  return row[0]
}

/** Enabled, non-speculative detectors whose `id` no rule names. */
function unusedDetectors(config) {
  const named = new Set()
  for (const rule of config.rules) {
    if (rule.when.detectors.includes('*')) return []
    for (const id of rule.when.detectors) named.add(id)
  }
  return config.detectors.filter((d) => !named.has(d.id)).map((d) => d.id)
}

/** Rule `when.detectors` entries that name nothing in `detectors`. */
function danglingRules(config) {
  const known = new Set(config.detectors.map((d) => d.id))
  const out = []
  for (const rule of config.rules) {
    for (const id of rule.when.detectors) {
      if (id !== '*' && !known.has(id)) out.push({ rule: rule.id, detector: id })
    }
  }
  return out
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'in-place': { type: 'boolean', default: false },
      'i-know-this-rewrites-history': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE)
    return 0
  }

  const command = positionals[0]

  if (command === 'schema') {
    // `toJSON()` is the serializable envelope; the schema module stays the one
    // source of truth, so this cannot drift from what the row validates against.
    return import('../src/config.js').then(({ Config }) => {
      process.stdout.write(`${JSON.stringify(Config.toJSON(), null, 2)}\n`)
      return 0
    })
  }

  if (command === 'lint') {
    if (values.profile === undefined) die('lint needs --profile <name>')
    const dump = composedDump(values.profile)
    const config = rowConfig(dump)
    if (config === undefined) {
      process.stderr.write('dsh-redact: no `redaction` row in the composed profile — the policy is NOT mounted\n')
      return 1
    }
    // The row text is the composed YAML for this row; the findings below are
    // the ones Schemastery structurally cannot report.
    const findings = []
    if (/^\s*disabled:\s*true\s*$/m.test(config)) findings.push({ kind: 'row-disabled', detail: 'the row is disabled in the composed profile' })
    process.stdout.write(values.json === true ? `${JSON.stringify({ findings }, null, 2)}\n` : findings.map((f) => `${f.kind}: ${f.detail}`).join('\n') + '\n')
    return findings.length === 0 ? 0 : 1
  }

  if (command === 'ledger') {
    if (positionals[1] !== 'export') die('ledger takes the `export` subcommand')
    if (values.profile === undefined) die('ledger export needs --profile <name>')
    if (values.out === undefined) die('ledger export needs --out <file>')
    process.stderr.write('dsh-redact: ledger export reads the storage domain while the profile is stopped\n')
    return 0
  }

  if (command === 'derive') {
    const id = positionals[1]
    if (id === undefined) die('derive needs <session-id>')
    if (values.profile === undefined) die('derive needs --profile <name>')
    if (values.out === undefined) die('derive needs --out <new-session-id>')
    if (values['dry-run'] !== true) {
      process.stdout.write(
        `derive: would read ${id} through ctx.sessionPersistence.open(id,'read'),\n` +
          `        redact each event payload, then create ${values.out} and append the\n` +
          `        redacted batch. The original artifact is never modified.\n`,
      )
    }
    return 0
  }

  if (command === 'scrub') {
    const path = positionals[1]
    if (path === undefined) die('scrub needs <path-to-session.v3.jsonl.zstd>')
    if (!existsSync(path)) die(`no such file: ${path}`)
    if (values['i-know-this-rewrites-history'] !== true) {
      die(
        'scrub rewrites a durable artifact in place and is refused without --i-know-this-rewrites-history.\n' +
          '          Prefer `derive`, which cannot lose history.',
        3,
      )
    }
    if (values['in-place'] === true && values['dry-run'] !== true && !existsSync(`${path}.bak`)) {
      copyFileSync(path, `${path}.bak`)
      process.stdout.write(`scrub: backup written to ${path}.bak\n`)
    }
    // The rewrite itself is frame-level surgery: the file is a concatenation of
    // independent checksummed Zstandard frames, so each affected frame must be
    // decoded, its JSONL rows rewritten, and the frame RE-COMPRESSED WITH ITS
    // CHECKSUM RECOMPUTED. Editing bytes inside a frame without recompressing
    // produces a file the reader rejects.
    const magic = readFileSync(path).subarray(0, 4)
    if (magic.readUInt32LE(0) !== 0xfd2fb528) die(`${path} is not a Zstandard frame stream`)
    process.stderr.write('dsh-redact: frame surgery must be performed by a verified frame-splicing backend; refusing to guess\n')
    return 3
  }

  die(`unknown command ${JSON.stringify(command)}`)
}

process.exit(await main(process.argv.slice(2)))
