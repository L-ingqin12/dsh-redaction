import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyPlan } from 'file:///%USERPROFILE%/dsh-plugin-redact/lib/engine.mjs'
import { Session, sessionFormatCatalog, headerFor, writeSessionLog, backendOpen } from 'file:///%USERPROFILE%/dsh-plugin-redact/test/real-reader.mjs'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-f4c-'))
const SESS = path.join(ROOT, 'sessions')
const SECRET = 'GOLD-SECRET-0123456789ABCDEFGHIJ'
const H = headerFor('f4c')
const built = writeSessionLog(SESS, '_no-cwd', 'f4c', H, (s) => {
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' })
  s.append('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: SECRET }] }] } }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
})
const before = fs.readFileSync(built.file)
const { out } = applyPlan(before, { substitutions: [{ find: SECRET, replace: '[已移除]' }] })
console.log('before', before.length, 'out', out.length, 'shrink?', out.length <= before.length)

const plugin = await import(pathToFileURL('%USERPROFILE%/dsh-plugin-redact/index.js').href)
let captured = null
plugin.apply({ commands: { register: (d) => { captured = d } }, get: () => undefined }, { root: SESS, cacheRoot: path.join(ROOT, 'storages'), placeholder: '[已移除]' })
const planFile = path.join(ROOT, 'plan.json')
fs.writeFileSync(planFile, JSON.stringify({ substitutions: [{ find: SECRET, replace: '[已移除]' }] }))

const realWrite = fs.writeSync
fs.writeSync = (...a) => {
  console.log('  [injected] writeSync called len=', a[3], 'pos=', a[4])
  throw new Error('模拟进程在截断之后、写入之前死掉')
}
let res
try {
  res = captured.handler({ rawInput: `apply "${planFile}" --session f4c --allow-live`, agent: { session: { id: 'f4c' } } })
} finally {
  fs.writeSync = realWrite
}
console.log('result:', res.kind, res.text)
const now = fs.readFileSync(built.file)
console.log('now', now.length, 'equals before.subarray(0,out.length)?', now.equals(before.subarray(0, out.length)))
console.log('open:', await backendOpen(SESS, 'f4c'))
fs.rmSync(ROOT, { recursive: true, force: true })
