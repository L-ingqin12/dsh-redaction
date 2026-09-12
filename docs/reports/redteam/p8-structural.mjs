/**
 * P8 — blankLines / substitutions 命中了「结构字符串」时，日志是否还打得开。
 * （blankLines 会把该行**所有非保护键**的字符串换成占位符：包含 source.kind、
 *   tool/call 的 name/arguments、model 名等。）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Session, headerFor, writeLog, backendOpen, ROOT } from './fixture.mjs'

const { applyPlan, scanFrames } = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/lib/engine.mjs').href)
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
const rowsOf = (buf) => scanFrames(buf).frames.flatMap((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n').filter(Boolean))

function mk(id) {
  const s = Session.create(id, undefined, headerFor(id), undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello SECRET' }] }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"echo SECRET"}' })
  s.append('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'SECRET output' }] }] } }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return writeLog(id, headerFor(id), s.snapshotEvents())
}

async function trial(label, id, plan) {
  const file = mk(id)
  const before = await backendOpen(id, ROOT)
  let res
  try { res = applyPlan(fs.readFileSync(file), plan) } catch (e) { res = { error: e.message } }
  if (res.error !== undefined) {
    console.log(`   ${label}: 引擎拒绝 → ${res.error.split('\n')[0]}`)
    return { rejected: true }
  }
  const out = rowsOf(res.out)
  const line = out.map((r) => JSON.parse(r))
  console.log(`   ${label}: 引擎报成功；夹具改写前可打开=${before.ok}`)
  fs.writeFileSync(file, res.out)
  const after = await backendOpen(id, ROOT)
  console.log(`      → 改写后 DSH 打开: ok=${after.ok} ${after.ok ? after.events.length + ' events' : after.error}`)
  return { rejected: false, after, line }
}

console.log('== A. blankLines 清空 user/message 行（3 = 第 3 个事件行） ==')
{
  const r = await trial('blankLines:3', 'rt-blank-user', { blankLines: '4' })
  if (!r.rejected) {
    assert('A. blankLines 后仍可打开', r.after.ok, r.after.error ?? '')
    const src = r.line.find((e) => e.type === 'user/message')
    console.log(`      → user/message 被清空后的 source/role: ${JSON.stringify({ role: src?.data?.role, source: src?.data?.source, id: src?.data?.id, content: src?.data?.message?.content?.[0]?.text })}`)
  }
}

console.log('\n== B. blankLines 清空 tool/call 行（含 name / arguments） ==')
{
  const r = await trial('blankLines:4', 'rt-blank-call', { blankLines: '5' })
  if (!r.rejected) {
    const c = r.line.find((e) => e.type === 'tool/call')
    console.log(`      → tool/call 变成: ${JSON.stringify(c?.data)}`)
    assert('B. blankLines 后仍可打开', r.after.ok, r.after.error ?? '')
  }
}

console.log('\n== C. substitutions 命中结构字符串（把 "pwsh" 换成 [X]） ==')
{
  const r = await trial('substitutions pwsh', 'rt-sub-name', { substitutions: [{ find: 'pwsh', replace: '[X]' }] })
  if (!r.rejected) {
    const c = r.line.find((e) => e.type === 'tool/call')
    console.log(`      → tool/call.name=${JSON.stringify(c?.data?.name)} arguments=${JSON.stringify(c?.data?.arguments)}`)
    assert('C. 替换后仍可打开', r.after.ok, r.after.error ?? '')
  }
}

console.log('\n== D. substitutions 命中 source.kind（find "user"） ==')
{
  const r = await trial('substitutions user', 'rt-sub-kind', { substitutions: [{ find: 'user', replace: '[X]' }] })
  if (!r.rejected) {
    const u = r.line.find((e) => e.type === 'user/message')
    console.log(`      → user/message.source=${JSON.stringify(u?.data?.source)} role=${JSON.stringify(u?.data?.role)}`)
    assert('D. 替换后仍可打开', r.after.ok, r.after.error ?? '')
  }
}

console.log('\n== E. substitutions 命中 model / provider 名 ==')
{
  const s = Session.create('rt-sub-model', undefined, headerFor('rt-sub-model'), undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'ok' }] }, stream: [] }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const file = writeLog('rt-sub-model', headerFor('rt-sub-model'), s.snapshotEvents())
  const before = await backendOpen('rt-sub-model', ROOT)
  const res = applyPlan(fs.readFileSync(file), { substitutions: [{ find: 'deepseek', replace: '[X]' }] })
  fs.writeFileSync(file, res.out)
  const after = await backendOpen('rt-sub-model', ROOT)
  const a = rowsOf(res.out).map((r) => JSON.parse(r)).find((e) => e.type === 'assistant/message')
  console.log(`      → 夹具前=${before.ok} 改写后=${after.ok} ${after.error ?? ''}`)
  console.log(`      → assistant/message.source=${JSON.stringify(a?.data?.message?.source)}`)
  assert('E. 替换 provider/model 后仍可打开', after.ok, after.error ?? '')
}

console.log(fail === 0 ? '\nP8: blankLines/substitutions 未破坏可读性' : `\nP8: ${fail} 条断言失败`)
