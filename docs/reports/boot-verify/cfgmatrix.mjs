// Throwaway: redact config-boundary matrix. Each case is written to cfgcase.json and
// booted through the real boot() path, so the observed outcome is exactly what a restart
// would do with that value in the profile patch layer.
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE = '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\nodejs-x64\\node-v22.21.0-win-x64\\node.exe'

// [label, configJson]  — JSON text so `null`/strings/numbers survive verbatim
const CASES = [
  ['omitted (no config key)', undefined],
  ['{}', {}],
  ['null (YAML `config:` left empty)', null],
  ['{bogus:1} unknown key', { bogus: 1 }],
  // argsCells
  ['argsCells: omitted', {}],
  ['argsCells: 0', { argsCells: 0 }],
  ['argsCells: 120', { argsCells: 120 }],
  ['argsCells: -1', { argsCells: -1 }],
  ['argsCells: 1.5', { argsCells: 1.5 }],
  ['argsCells: "5000"', { argsCells: '5000' }],
  ['argsCells: null', { argsCells: null }],
  ['argsCells: NaN-ish "abc"', { argsCells: 'abc' }],
  // dialogTimeoutMs
  ['dialogTimeoutMs: omitted', {}],
  ['dialogTimeoutMs: 0 (disabled)', { dialogTimeoutMs: 0 }],
  ['dialogTimeoutMs: 15000', { dialogTimeoutMs: 15000 }],
  ['dialogTimeoutMs: -1', { dialogTimeoutMs: -1 }],
  ['dialogTimeoutMs: 1.5', { dialogTimeoutMs: 1.5 }],
  ['dialogTimeoutMs: "5000"', { dialogTimeoutMs: '5000' }],
  ['dialogTimeoutMs: null', { dialogTimeoutMs: null }],
  // both together, valid
  ['argsCells:0 + dialogTimeoutMs:0', { argsCells: 0, dialogTimeoutMs: 0 }],
]

const rows = []
for (const [label, cfg] of CASES) {
  if (cfg === undefined) {
    // no config key at all
    writeFileSync(path.join(HERE, 'cfgcase.json'), 'null')
  } else {
    writeFileSync(path.join(HERE, 'cfgcase.json'), JSON.stringify(cfg))
  }
  const argv = cfg === undefined ? ['redactNoConfig', '8000'] : ['redactCfgFile', '8000']
  const r = spawnSync(NODE, [path.join(HERE, 'probe.mjs'), ...argv], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\.dsh' },
  })
  let out
  try { out = JSON.parse(r.stdout.trim().split('\n')[0]) } catch { out = { outcome: `RAW(${r.status}) ${r.stdout.slice(0, 160)}` } }
  const reason = (() => {
    const m = String(out.message ?? '')
    const hit = m.match(/dsh-redact: invalid config: [^\\\n]+/)
    if (hit) return hit[0]
    const first = m.split('\n')[0]
    return first.slice(0, 150)
  })()
  const msg = out.outcome === 'BOOT_OK'
    ? `OK  entries=[${out.entries.filter((e) => e.id === 'dsh-redact').map((e) => `${e.id}:${e.state}`).join(' ')}] commands=${JSON.stringify(out.commandsRegistered)}`
    : `${out.outcome}  ${reason}`
  rows.push(`${label.padEnd(34)} ${msg}`)
}
console.log(rows.join('\n'))
