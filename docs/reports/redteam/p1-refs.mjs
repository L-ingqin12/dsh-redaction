/**
 * P1 — renumber 删除留下的悬空/错位引用：
 *   (a) on-disk sourceEventSeqs 是「游程压缩」形式 (number | [start,end])，
 *       引擎 remapRefs 只重映射整数，区间原样保留 → 读取端硬拒绝。
 *   (b) session/title.data.messageSeqs 完全不在引擎的引用清单里。
 * 输出：引擎是否报成功；DSH 真实后端是否还打得开。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
const { applyPlan, checkSeqDensity, scanFrames } = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/lib/engine.mjs').href)
import { Session, headerFor, writeLog, backendOpen, ROOT, rmrf, imp, decodeRows } from './fixture.mjs'

rmrf(ROOT)
fs.mkdirSync(ROOT, { recursive: true })
let fail = 0
const say = (s) => console.log(s)
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const plainRows = (buf) => {
  const parts = []
  for (const f of scanFrames(buf).frames) parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
  return parts.join('').split('\n').filter(Boolean)
}

// ============================================================ (a) sourceEventSeqs 游程
{
  const id = 'rt-run-refs'
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'a1' }] }, stream: [] }, { surfaceOp: 'append' })
  s.append('user/message', { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] }, { surfaceOp: 'append' })
  // 替换节点：遮蔽 surface 节点 2..4，来源 seq 是连续 3 个 → 落盘必被压成 [[2,4]]
  s.append('user/message', { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] },
    { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [2, 3, 4] })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const events = s.snapshotEvents()
  const file = writeLog(id, H, events)

  const rows = plainRows(fs.readFileSync(file))
  const repl = JSON.parse(rows[6])
  assert('(a) 夹具：落盘的 sourceEventSeqs 确实是游程形式', Array.isArray(repl.sourceEventSeqs?.[0]),
    `sourceEventSeqs=${JSON.stringify(repl.sourceEventSeqs)} surfaceOp=${JSON.stringify(repl.surfaceOp)}`)

  const before = await backendOpen(id)
  assert('(a) 夹具：改写前 DSH 真实后端可打开', before.ok, before.error ?? `${before.events.length} events`)

  // 删掉中间一行（seq 1 = step/start，文件第 3 行）并 renumber
  const plan = { dropLines: '3', renumber: true }
  let res
  try { res = applyPlan(fs.readFileSync(file), plan) } catch (e) { res = { error: e.message } }
  assert('(a) 引擎接受 renumber 删除（无悬空引用告警）', res.error === undefined, res.error ?? `dropped=${res.stats?.dropped}`)

  if (res.error === undefined) {
    const out = path.join(path.dirname(file), 'out-a.zstd')
    fs.writeFileSync(out, res.out)
    assert('(a) 引擎自检通过（seq 密集 + JSON 可解析）', checkSeqDensity(res.out) === null)
    const outRows = plainRows(res.out)
    const repl2 = JSON.parse(outRows[5])
    say(`      → 改写后该行: seq=${repl2.seq} surfaceOp=${JSON.stringify(repl2.surfaceOp)} sourceEventSeqs=${JSON.stringify(repl2.sourceEventSeqs)}`)
    assert('(a) surfaceOp 被正确重映射', repl2.surfaceOp.startSeq === 1 && repl2.surfaceOp.endSeq === 3)
    assert('(a) 游程 sourceEventSeqs 未被重映射（仍是 [[2,4]]）', JSON.stringify(repl2.sourceEventSeqs) === '[[2,4]]')

    // 用真实后端打开工具的输出
    const dir = path.join(ROOT, '_no-cwd', id)
    fs.copyFileSync(file, path.join(dir, 'orig.keep.zstd'))
    fs.copyFileSync(out, file)
    const after = await backendOpen(id)
    assert('(a) DSH 真实后端仍能打开引擎的输出', after.ok, after.ok ? `${after.events.length} events` : after.error)
    fs.copyFileSync(path.join(dir, 'orig.keep.zstd'), file)
  }
}

// ============================================================ (b) session/title.messageSeqs
{
  const id = 'rt-title-refs'
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'FIRST-PROMPT' }] }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] }, stream: [] }, { surfaceOp: 'append' })
  s.append('session/title', { title: 'T', messageSeqs: [2], source: { kind: 'fallback' } })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const events = s.snapshotEvents()
  const file = writeLog(id, H, events)
  const rows = plainRows(fs.readFileSync(file))
  const hdr = JSON.parse(rows[0])
  say(`      夹具行类型: ${rows.map((r, i) => `${i + 1}:${JSON.parse(r).type}`).join(' ')}`)
  const titleRow = rows.map((r) => JSON.parse(r)).find((r) => r.type === 'session/title')
  say(`      session/title.data = ${JSON.stringify(titleRow.data)}`)

  const before = await backendOpen(id)
  assert('(b) 夹具：改写前可打开', before.ok, before.error ?? '')

  const res = applyPlan(fs.readFileSync(file), { dropLines: '3', renumber: true })
  assert('(b) 引擎接受 renumber 删除', res !== undefined)
  const outRows = plainRows(res.out)
  const t = outRows.map((r) => JSON.parse(r)).find((r) => r.type === 'session/title')
  say(`      → 改写后 session/title: seq=${t.seq} messageSeqs=${JSON.stringify(t.data.messageSeqs)}`)
  assert('(b) messageSeqs 未被重映射（仍是 [2]）', JSON.stringify(t.data.messageSeqs) === '[2]')
  const cited = outRows.map((r) => JSON.parse(r))[t.data.messageSeqs[0] + 1]
  assert('(b) 该引用现在指向的不是 user/message（悬空）', cited?.type !== 'user/message', `指向 ${cited?.type}`)

  // 用真实 dsh-session-title 不变式复核
  const { apply: installTitle } = await imp('dsh-session-title/lib/types/invariant.js')
  let captured
  installTitle({ invariants: { register: (_n, f) => { captured = f } }, sessions: { list: () => [] }, on: () => {} })
  const decoded = outRows.map((r) => JSON.parse(r))
  const fakeSession = {
    snapshotEvents: () => decoded,
    eventAt: (q) => decoded[q + 1],
  }
  let invErr
  try { captured({ sessions: { list: () => [fakeSession] }, on: () => {} }, (m) => { throw new Error(m) }) } catch (e) { invErr = e.message }
  assert('(b) 真实 title 不变式接受改写后的日志', invErr === undefined, invErr ?? '通过')
}

console.log(fail === 0 ? '\nP1: 全部断言通过（=未发现问题）' : `\nP1: ${fail} 条断言失败（=发现真实缺陷）`)
