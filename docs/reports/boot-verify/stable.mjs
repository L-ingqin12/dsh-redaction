// Throwaway: hash-bracketed verification that RETRIES until the package revision is
// stable across the whole run. redact/index.js was being edited while earlier sweeps
// ran, which makes any single sweep unattributable to one revision.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE = '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\nodejs-x64\\node-v22.21.0-win-x64\\node.exe'
const FILES = [
  '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\dsh-plugin-redact\\index.js',
  '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\dsh-plugin-redact\\lib\\engine.mjs',
  '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\dsh-plugin-content-policy\\index.js',
  '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\dsh-plugin-content-policy\\lib\\scrub.mjs',
  '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\.dsh\\profiles\\dsh-tui\\cordis.patch.yml',
]
const stamp = () => FILES.map((f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)).join(' ')

const runProbe = (args) => {
  const r = spawnSync(NODE, [path.join(HERE, 'probe.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '\\.dsh' },
  })
  try { return JSON.parse(r.stdout.trim().split('\n')[0]) } catch { return { outcome: `RAW(${r.status})`, message: r.stdout.slice(0, 200) } }
}
const reasonOf = (out) => {
  const m = String(out.message ?? '')
  const hit = m.match(/dsh-redact: invalid config: [^\\\n]+/)
  return hit ? hit[0] : m.split('\n').filter(Boolean).slice(-1)[0].slice(0, 150)
}
const brief = (out) => (out.outcome === 'BOOT_OK'
  ? `BOOT_OK  entries=[${out.entries.map((e) => `${e.id}:${e.state}`).join(' ')}] commands=${JSON.stringify(out.commandsRegistered)}`
  : `${out.outcome}  ${reasonOf(out)}`)

const BOOT_CASES = ['real', 'realProfilePatch', 'profilePatchNoDialogs', 'profilePatchLateDialogs', 'rowInjectAdditive']
const CFG_CASES = [
  ['omitted', undefined], ['{}', {}], ['null', null], ['{bogus:1}', { bogus: 1 }],
  ['argsCells:0', { argsCells: 0 }], ['argsCells:120', { argsCells: 120 }], ['argsCells:-1', { argsCells: -1 }],
  ['argsCells:1.5', { argsCells: 1.5 }], ['argsCells:"5000"', { argsCells: '5000' }], ['argsCells:null', { argsCells: null }],
  ['dialogTimeoutMs:0', { dialogTimeoutMs: 0 }], ['dialogTimeoutMs:15000', { dialogTimeoutMs: 15000 }],
  ['dialogTimeoutMs:-1', { dialogTimeoutMs: -1 }], ['dialogTimeoutMs:1.5', { dialogTimeoutMs: 1.5 }],
  ['dialogTimeoutMs:"5000"', { dialogTimeoutMs: '5000' }], ['dialogTimeoutMs:null', { dialogTimeoutMs: null }],
]

let attempt = 0
let report = []
let stable = false
while (attempt < 6 && !stable) {
  attempt += 1
  const before = stamp()
  const lines = [`===== attempt ${attempt} =====`, `BEFORE ${before}`]
  for (const s of BOOT_CASES) lines.push(`  ${s.padEnd(24)} ${brief(runProbe([s, '8000']))}`)
  for (const [label, cfg] of CFG_CASES) {
    writeFileSync(path.join(HERE, 'cfgcase.json'), JSON.stringify(cfg ?? null))
    const out = cfg === undefined ? runProbe(['redactNoConfig', '8000']) : runProbe(['redactCfgFile', '8000'])
    lines.push(`  cfg ${label.padEnd(20)} ${brief(out)}`)
  }
  const after = stamp()
  lines.push(`AFTER  ${after}`)
  stable = before === after
  lines.push(stable ? 'STABLE: revision unchanged across the whole run' : 'UNSTABLE: package edited mid-run, retrying')
  report = lines
}

writeFileSync(path.join(HERE, 'stable.txt'), report.join('\n'))
console.log(report.join('\n'))
console.log(`\nattempts=${attempt} stable=${stable}`)
