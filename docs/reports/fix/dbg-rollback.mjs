import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), CHECKSUM)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-rb-'))
const sessionsRoot = path.join(root, 'sessions')
const sid = 'sess-0001'
const dir = path.join(sessionsRoot, '--proj--', sid)
fs.mkdirSync(dir, { recursive: true })
const log = path.join(dir, 'session.v3.jsonl.zstd')
const header = JSON.stringify({ type: 'session', version: 3, id: sid, createdAt: 1, cwd: 'C:\\proj', isSeeded: false, delegationDepth: 0 })
const ev = (n, type, data) => JSON.stringify({ type, seq: n, time: 1000 + n, data })
const rows = [
  ev(0, 'turn/start', { turn: 1 }),
  ev(1, 'user/message', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  ev(2, 'turn/end', { turn: 1 }),
  ev(3, 'turn/start', { turn: 2 }),
  ev(4, 'tool/result', { turn: 2, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'GOLD-SECRET here' }] }] } }),
  ev(5, 'turn/end', { turn: 2 }),
  ev(6, 'turn/start', { turn: 3 }),
  ev(7, 'turn/end', { turn: 3 }),
]
fs.writeFileSync(log, Buffer.concat([frame(header + '\n'), frame(rows.join('\n') + '\n')]))

const mod = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js').href)
let captured = null
mod.apply({ commands: { register: (d) => { captured = d } }, get: () => undefined }, { root: sessionsRoot, cacheRoot: path.join(root, 'storages'), placeholder: '[已移除]' })
const call = (raw) => captured.handler({ rawInput: raw, agent: { session: { id: 'other-session' } } })
console.log('rollback:', JSON.stringify(await call(`rollback 1 --session ${sid} --commit`), null, 1))
console.log('files:', fs.readdirSync(dir))
fs.rmSync(root, { recursive: true, force: true })
