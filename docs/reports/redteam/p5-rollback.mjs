/**
 * P5 — rollback 边界逻辑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Session, sessionFormatCatalog, headerFor, writeLog, writeRawLog, backendOpen, ROOT } from './fixture.mjs'

const { scanFrames } = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/lib/engine.mjs').href)
const mod = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js').href)

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })
const CACHE = path.join(os.tmpdir(), 'rt-redact', 'cache5')
let captured = null
mod.apply({ commands: { register: (d) => { captured = d } }, get: () => undefined }, { root: ROOT, cacheRoot: CACHE })
const call = (raw) => captured.handler({ rawInput: raw, agent: { session: { id: 'other' } } })

let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
const plainOf = (file) => scanFrames(fs.readFileSync(file)).frames.map((f) => zlib.zstdDecompressSync(fs.readFileSync(file).subarray(f.start, f.end)).toString('utf8')).join('')

function mkTurns(id, turns) {
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  for (const [t, open] of turns) {
    s.append('turn/start', { turn: t })
    s.append('step/start', { turn: t, step: 1 })
    s.append('user/message', { id: `u${t}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${t}` }] }, { surfaceOp: 'append' })
    if (!open) { s.append('step/end', { turn: t, step: 1 }); s.append('turn/end', { turn: t, reason: { kind: 'completed' } }) }
  }
  return writeLog(id, H, s.snapshotEvents())
}

// ============ A. 末尾是「未闭合的 turn」
{
  const id = 'rt-rb-open'
  const file = mkTurns(id, [[1, false], [2, false], [3, false], [4, true]])
  const before = await backendOpen(id, ROOT)
  console.log(`      → 改写前：ok=${before.ok} events=${before.events?.length}（末尾 turn 4 未闭合）`)
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  assert('A. 回退成功', r.kind === 'success', r.text)
  const after = await backendOpen(id, ROOT)
  assert('A. 回退后仍可打开', after.ok, after.error ?? `${after.events.length} events`)
  const p = plainOf(file)
  assert('A. 未闭合的 turn 4 一并被截掉', !p.includes('"turn":4'))
  assert('A. 保留到 turn 2', p.includes('"turn":1') && p.includes('"turn":2') && !p.includes('"turn":3'))
}

// ============ B. 末尾没有 turn/end（第 3 轮也未闭合）
{
  const id = 'rt-rb-noend'
  const file = mkTurns(id, [[1, false], [2, false], [3, true]])
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  const after = await backendOpen(id, ROOT)
  assert('B. 只按完整轮次计数，回退 1 轮后可打开', r.kind === 'success' && after.ok, (after.error ?? `${after.events.length} events`))
}

// ============ C. 种入型会话的 inherited end-seed 必须被保护
{
  const id = 'rt-rb-seed'
  const rows = []
  let n = 0
  const ev = (type, data, extra = {}) => JSON.stringify({ type, seq: n++, time: 1000 + n, data, ...extra })
  for (const t of [1]) {
    rows.push(ev('turn/start', { turn: t }))
    rows.push(ev('step/start', { turn: t, step: 1 }))
    rows.push(ev('user/message', { id: `u${t}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${t}` }] }, { surfaceOp: 'append' }))
    rows.push(ev('step/end', { turn: t, step: 1 }))
    rows.push(ev('turn/end', { turn: t, reason: { kind: 'completed' } }))
  }
  rows.push(ev('session/end-seed', { inherited: true, parentSession: 'p' }))
  rows.push(ev('turn/start', { turn: 2 }))
  rows.push(ev('step/start', { turn: 2, step: 1 }))
  rows.push(ev('user/message', { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] }, { surfaceOp: 'append' }))
  rows.push(ev('step/end', { turn: 2, step: 1 }))
  rows.push(ev('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  writeRawLog(id, headerFor(id, { isSeeded: true }), rows)
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  assert('C. 截断会移除 inherited end-seed 时被拒绝', r.kind === 'error' && /end-seed/.test(r.text), r.text)
}

// ============ D. payload 里出现 turn/end 字样不算边界
{
  const id = 'rt-rb-decoy'
  const s = Session.create(id, undefined, headerFor(id), undefined)
  for (const n of [1, 2]) {
    s.append('turn/start', { turn: n })
    s.append('step/start', { turn: n, step: 1 })
    s.append('user/message', { id: `u${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${n}` }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: n, step: 1 })
    s.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  const evs = [...s.snapshotEvents()]
  evs.push({ type: 'tool/result', seq: evs.length, time: 1, data: { turn: 2, step: 1, message: { id: 'x', role: 'tool', source: { callId: 'c' }, content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'a turn/end row inside a payload' }] }] } }, surfaceOp: 'append' })
  const rows = evs.map((e) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(e)))
  writeRawLog(id, headerFor(id), rows)
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  assert('D. 只有顶层 type=turn/end 计入边界（共 2 轮）', r.kind === 'success' && /共 2 个完整轮次/.test(r.text), r.text)
}

// ============ E. turn/end 顺序错乱
{
  const id = 'rt-rb-order'
  const s = Session.create(id, undefined, headerFor(id), undefined)
  for (const n of [1, 2, 3]) {
    s.append('turn/start', { turn: n })
    s.append('step/start', { turn: n, step: 1 })
    s.append('user/message', { id: `u${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${n}` }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: n, step: 1 })
    s.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  const evs = [...s.snapshotEvents()]
  const i2 = evs.findIndex((e) => e.type === 'turn/end' && e.data.turn === 2)
  const [end2] = evs.splice(i2, 1)
  evs.push(end2)
  const rows = evs.map((e, i) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent({ ...e, seq: i })))
  writeRawLog(id, headerFor(id), rows)
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  const after = await backendOpen(id, ROOT)
  console.log(`      → 回退后可打开=${after.ok} ${after.ok ? after.events.length + ' events' : after.error}`)
}

// ============ F. 后缀截断把「compaction/prune 孤儿价签」留在末尾
{
  const id = 'rt-rb-orphan'
  const s = Session.create(id, undefined, headerFor(id), undefined)
  for (const n of [1, 2]) {
    s.append('turn/start', { turn: n })
    s.append('step/start', { turn: n, step: 1 })
    s.append('user/message', { id: `u${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${n}` }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: n, step: 1 })
    s.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  const evs = [...s.snapshotEvents()]
  evs.push({ type: 'compaction/prune', seq: evs.length, time: 1, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 5 } })
  writeRawLog(id, headerFor(id), evs.map((e) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(e))))
  const r = await call(`rollback 1 --session ${id} --commit`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  const after = await backendOpen(id, ROOT)
  console.log(`      → 回退后可打开=${after.ok} ${after.ok ? after.events.length + ' events' : after.error}`)
}

console.log(fail === 0 ? '\nP5: 未发现 rollback 边界缺陷' : `\nP5: ${fail} 条断言失败`)
