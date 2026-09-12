// Throwaway: run the whole boot-scenario sweep against the LIVE plugin revisions,
// bracketed by SHA-256 hashes so the verified revision is unambiguous.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE = '%USERPROFILE%\\nodejs-x64\\node-v22.21.0-win-x64\\node.exe'
const FILES = [
  '%USERPROFILE%\\dsh-plugin-redact\\index.js',
  '%USERPROFILE%\\dsh-plugin-redact\\lib\\engine.mjs',
  '%USERPROFILE%\\dsh-plugin-redact\\cordis.patch.yml',
  '%USERPROFILE%\\dsh-plugin-content-policy\\index.js',
  '%USERPROFILE%\\dsh-plugin-content-policy\\lib\\scrub.mjs',
  '%USERPROFILE%\\dsh-plugin-content-policy\\cordis.patch.yml',
]
const hash = () =>
  FILES.map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}  ${f}`).join('\n')

console.log('===== BEFORE =====')
console.log(hash())

const SCENARIOS = ['real', 'realEcho', 'realProfilePatch', 'profilePatchNoDialogs', 'profilePatchLateDialogs', 'rowInjectAdditive', 'dialogsAbsent', 'dialogsBefore', 'dialogsAfter', 'throwImport', 'throwApply', 'hang', 'missing', 'pending', 'badConfig', 'badApply', 'dupRules', 'redactBadShape', 'redactNoConfig', 'redactNullConfig']
for (const s of SCENARIOS) {
  const r = spawnSync(NODE, [path.join(HERE, 'probe.mjs'), s, '6000'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: '%USERPROFILE%\\.dsh' } })
  let line = ''
  try { line = JSON.parse(r.stdout.trim().split('\n')[0]) } catch { line = { outcome: `RAW(${r.status}) ${r.stdout.slice(0, 200)}` } }
  const summary = line.outcome === 'BOOT_OK'
    ? `BOOT_OK  entries=[${line.entries.map((e) => `${e.id}:${e.state}`).join(' ')}] commands=${JSON.stringify(line.commandsRegistered)}`
    : `${line.outcome}  ${String(line.message ?? '').split('\n').filter(Boolean).slice(-1)[0].slice(0, 170)}`
  console.log(`${s.padEnd(24)} ${summary}`)
}

console.log('===== AFTER =====')
console.log(hash())
