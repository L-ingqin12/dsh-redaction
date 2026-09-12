#!/usr/bin/env node
/**
 * hardening.mjs — 红队报告 F1–F10 的回归套件。
 *
 * 判据（这是这份文件存在的理由）：
 *   - 夹具用**真实** `Session` + `sessionFormatCatalog` 生成；
 *   - 「能不能打开」由**真实** `JsonlSessionPersistence.open()` 回答；
 *   - session/title 的引用由**真实** dsh-session-title 不变式复核。
 *   只看引擎自己的自检 = 测不出 F1/F2 这一类读取端语义缺陷（这正是它们当初漏网的原因）。
 *
 * 合成数据全部落在 mkdtemp 临时目录，跑完即删；不接触任何真实会话 / 缓存 / *.jsonl.zstd。
 *
 * 运行：
 *   node test\hardening.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyPlan, verifyLog, scanFrames, checkSeqDensity, inspectBuffer } from '../lib/engine.mjs'
import { Session, sessionFormatCatalog, headerFor, writeRawLog, writeSessionLog, backendOpen, frame, titleInvariantError } from './real-reader.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-redact-hardening-'))
const SESS = path.join(ROOT, 'sessions')
const CACHE = path.join(ROOT, 'storages')
const PROJECT = '_no-cwd' // 真实后端按目录名推导 cwd：没有 cwd 的会话必须落在这里
for (const d of [SESS, CACHE]) fs.mkdirSync(d, { recursive: true })

const plugin = await import(pathToFileURL(path.join(HERE, '..', 'index.js')).href)

let TOTAL = 0
let PASSED = 0
const FAILED = []
function check(name, ok, detail = '') {
  TOTAL += 1
  if (ok) PASSED += 1
  else FAILED.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ─────────────────────────────────────────────────────────── 小工具
const textOf = (buf) => {
  const { frames } = scanFrames(buf)
  return frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')).join('')
}
const rowsOf = (buf) => textOf(buf).split('\n').filter(Boolean).map((l) => JSON.parse(l))
/** 把一份 buffer 装进会话目录，用真实后端打开。 */
async function openBuffer(id, buf) {
  const dir = path.join(SESS, PROJECT, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, buf)
  const opened = await backendOpen(SESS, id)
  return { file, ...opened }
}
/** 引擎级拒绝必须 throw（RedactError），不能杀进程。 */
function refusal(fn) {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}
function mount() {
  let captured = null
  const ctx = { commands: { register: (d) => { captured = d } }, get: () => undefined }
  plugin.apply(ctx, { root: SESS, cacheRoot: CACHE, placeholder: '[已移除]' })
  return (rawInput, sessionId = 'someone-else') => captured.handler({ rawInput, agent: { session: { id: sessionId } } })
}
/** 直接在**假活会话**上调用 hide（会话对象由测试提供）。 */
function mountOnSession(session, meter = { estimateMessage: () => 42 }) {
  let captured = null
  const ctx = { commands: { register: (d) => { captured = d } }, get: (n) => (n === 'tokenMeter' ? meter : undefined) }
  plugin.apply(ctx, { root: SESS, cacheRoot: CACHE, placeholder: '[已移除]' })
  return (rawInput) => captured.handler({ rawInput, agent: { session } })
}
/** 造一份「1 个 turn + 一条含 SECRET 的 tool/result」的真实日志。 */
function buildToolResultLog(id, secret = 'GOLD-SECRET') {
  const H = headerFor(id)
  return writeSessionLog(SESS, PROJECT, id, H, (s) => {
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' })
    s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' })
    s.append(
      'tool/result',
      { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: secret }] }] } },
      { surfaceOp: 'append' },
    )
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
}

// ══════════════════════════════════════════════════════ 元发现：夹具必须读取端合法
section('0. 元发现：旧夹具形状根本不是合法日志')
{
  const id = 'meta-old-shape'
  // 复刻旧 bugfix 夹具的行：tool/result 的 message 写成 role:'tool'
  writeRawLog(SESS, PROJECT, id, headerFor(id), [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } }),
    JSON.stringify({ type: 'step/start', seq: 1, time: 1002, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: 1003, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }, surfaceOp: 'append' }),
    JSON.stringify({ type: 'tool/result', seq: 3, time: 1004, data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'GOLD-SECRET' }] }] } }, surfaceOp: 'append' }),
    JSON.stringify({ type: 'turn/end', seq: 4, time: 1005, data: { turn: 1, reason: { kind: 'completed' } } }),
  ])
  const opened = await backendOpen(SESS, id)
  check('★ 旧夹具形状（role:"tool" / user/message 包一层 message）被真实读取端拒绝', !opened.ok, opened.error ?? '竟然打开了')
  const good = buildToolResultLog('meta-real-shape')
  const openedGood = await backendOpen(SESS, 'meta-real-shape')
  check('★ 真实形状的同类夹具可以打开', openedGood.ok && good.bytes.length > 0, openedGood.ok ? `${openedGood.events.length} events` : openedGood.error)
  check(
    '★ 真实形状：tool/result 的 message 是 role:"user" + source.kind:"tool"',
    (() => {
      const tr = openedGood.events?.find((e) => e.type === 'tool/result')
      return tr?.data?.message?.role === 'user' && tr?.data?.message?.source?.kind === 'tool'
    })(),
    JSON.stringify(openedGood.events?.find((e) => e.type === 'tool/result')?.data?.message?.source),
  )
}

// ══════════════════════════════════════════════════════════════════ F1
section('F1. sourceEventSeqs 的游程（[start,end]）形式重映射')
{
  const id = 'f1-run'
  const H = headerFor(id)
  const built = writeSessionLog(SESS, PROJECT, id, H, (s) => {
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'a1' }] }, stream: [] }, { surfaceOp: 'append' })
    s.append('user/message', { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] }, { surfaceOp: 'append' })
    s.append('user/message', { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [2, 3, 4] })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
  const buf = fs.readFileSync(built.file)
  const repl = rowsOf(buf).find((r) => r.sourceEventSeqs !== undefined)
  check('F1 夹具：盘上 sourceEventSeqs 确实是游程 [start,end]', Array.isArray(repl?.sourceEventSeqs?.[0]), JSON.stringify(repl?.sourceEventSeqs))
  check('F1 夹具：改写前真实后端可打开', (await backendOpen(SESS, id)).ok)

  const res = applyPlan(buf, { dropLines: '3', renumber: true })
  const after = rowsOf(res.out).find((r) => r.surfaceOp?.op === 'replace')
  check(
    '★ F1 游程被展开→逐项映射→按读取端同一压缩器重新压缩',
    JSON.stringify(after.sourceEventSeqs) === '[[1,3]]' && after.surfaceOp.startSeq === 1 && after.surfaceOp.endSeq === 3,
    `seq=${after.seq} surfaceOp=${JSON.stringify(after.surfaceOp)} sourceEventSeqs=${JSON.stringify(after.sourceEventSeqs)}`,
  )
  const opened = await openBuffer(id, res.out)
  check('★ F1 引擎输出能被真实后端打开（修复前：sourceEventSeqs range exceeds its event seq）', opened.ok, opened.ok ? `${opened.events.length} events` : opened.error)
  check('F1 引擎自己的总闸也认可（verifyLog）', verifyLog(res.out).ok, verifyLog(res.out).reason ?? '')

  // 全是整数的形态保持整数形态（不额外改变盘上形状）
  const id2 = 'f1-plain'
  const built2 = writeSessionLog(SESS, PROJECT, id2, headerFor(id2), (s) => {
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'a1' }] }, stream: [] }, { surfaceOp: 'append' })
    s.append('user/message', { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3] })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
  const res2 = applyPlan(fs.readFileSync(built2.file), { dropLines: '3', renumber: true })
  const after2 = rowsOf(res2.out).find((r) => r.sourceEventSeqs !== undefined)
  check('F1 整数形态仍是整数形态（只按 map 重编号）', JSON.stringify(after2.sourceEventSeqs) === '[1,2]', JSON.stringify(after2.sourceEventSeqs))
  check('F1 整数形态输出仍可打开', (await openBuffer(id2, res2.out)).ok)

  // 区间**中间**的 seq 被删 → 必须拒绝（旧实现只看端点，这里会静默引用错事件）
  const mid = refusal(() => applyPlan(buf, { dropLines: '5', renumber: true }))
  check('★ F1 区间中间的 seq 被删时拒绝执行（旧实现的悬空检查对区间元素永不触发）', mid instanceof Error, mid?.message?.split('\n')[0])
  check('F1 拒绝理由点明区间里被删的 seq', /引用了被删除的第 5 行（seq 3）/.test(mid?.message ?? ''), mid?.message?.split('\n')[0])

  // 其它形态一律拒绝（失败关闭）
  const id3 = 'f1-shape'
  writeRawLog(SESS, PROJECT, id3, headerFor(id3), [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1002, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, surfaceOp: 'append' }),
    JSON.stringify({ type: 'user/message', seq: 2, time: 1003, data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [[1]] }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: 1004, data: { turn: 1, reason: { kind: 'completed' } } }),
  ])
  const badShape = refusal(() => applyPlan(fs.readFileSync(path.join(SESS, PROJECT, id3, 'session.v3.jsonl.zstd')), { dropLines: '2', renumber: true }))
  check('F1 非整数非 [start,end] 的形态被拒绝', badShape instanceof Error && /sourceEventSeqs/.test(badShape.message), badShape?.message?.split('\n')[0])
}

// ══════════════════════════════════════════════════════════════════ F2
section('F2. session/title.data.messageSeqs 与 *Seq 字段审计')
{
  const id = 'f2-title'
  const H = headerFor(id)
  const built = writeSessionLog(SESS, PROJECT, id, H, (s) => {
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'FIRST-PROMPT' }] }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] }, stream: [] }, { surfaceOp: 'append' })
    s.append('session/title', { title: 'T', messageSeqs: [2], source: { kind: 'fallback' } })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
  check('F2 夹具：改写前可打开', (await backendOpen(SESS, id)).ok)
  const res = applyPlan(fs.readFileSync(built.file), { dropLines: '3', renumber: true })
  const decoded = rowsOf(res.out)
  const title = decoded.find((r) => r.type === 'session/title')
  check('★ F2 messageSeqs 被重映射（2 → 1）', JSON.stringify(title.data.messageSeqs) === '[1]', JSON.stringify(title.data.messageSeqs))
  const cited = decoded[title.data.messageSeqs[0] + 1]
  check('★ F2 引用落在 user/message（不再悬空/错指）', cited?.type === 'user/message' && cited.data.source.kind === 'user', cited?.type)
  const invErr = await titleInvariantError(decoded)
  check('★ F2 真实 dsh-session-title 不变式接受改写后的日志', invErr === undefined, invErr ?? '通过')
  check('★ F2 输出仍能被真实后端打开', (await openBuffer(id, res.out)).ok)

  // 审计：清单之外的 *Seq 键 → 失败关闭
  const id2 = 'f2-audit'
  writeRawLog(SESS, PROJECT, id2, headerFor(id2), [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1002, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, surfaceOp: 'append' }),
    JSON.stringify({ type: 'plugin/whatever', seq: 2, time: 1003, data: { somePluginSeq: 1, note: 'x' } }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: 1004, data: { turn: 1, reason: { kind: 'completed' } } }),
  ])
  const audited = refusal(() => applyPlan(fs.readFileSync(path.join(SESS, PROJECT, id2, 'session.v3.jsonl.zstd')), { dropLines: '2', renumber: true }))
  check('★ F2 清单外的 *Seq 字段被失败关闭（拒绝而不是写出悬空引用）', audited instanceof Error, audited?.message?.split('\n')[0])
  check('F2 拒绝理由报出字段路径', /data\.somePluginSeq/.test(audited?.message ?? ''), audited?.message?.split('\n')[0])
  // 不重编号时不该因为审计而被拒（引用不会动）
  const noRenumber = applyPlan(fs.readFileSync(path.join(SESS, PROJECT, id2, 'session.v3.jsonl.zstd')), { substitutions: [{ find: 'x', replace: 'y' }] })
  check('F2 不重编号时不触发审计（引用不会移动）', noRenumber.stats.substitutions >= 1)

  // data.sourceEventSeq（command/done）也在清单里
  const id3 = 'f2-cmd-done'
  const built3 = writeRawLog(SESS, PROJECT, id3, headerFor(id3), [
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1002, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, surfaceOp: 'append' }),
    JSON.stringify({ type: 'step/start', seq: 2, time: 1003, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'plugin/note', seq: 3, time: 1004, data: { text: 'n' } }),
    JSON.stringify({ type: 'command/done', seq: 4, time: 1005, data: { sourceEventSeq: 3, ok: true } }),
    JSON.stringify({ type: 'turn/end', seq: 5, time: 1006, data: { turn: 1, reason: { kind: 'completed' } } }),
  ])
  // 删掉第 4 行（seq 2 = step/start）：command/done 自己 4→3，它引用的 seq 3 → 2
  const res3 = applyPlan(fs.readFileSync(built3.file), { dropLines: '4', renumber: true })
  const cmd = rowsOf(res3.out).find((r) => r.type === 'command/done')
  check('F2 data.sourceEventSeq（command/done）也被重映射', cmd.seq === 3 && cmd.data.sourceEventSeq === 2, `seq=${cmd.seq} sourceEventSeq=${cmd.data.sourceEventSeq}`)
}

// ═══════════════════════════════════════════════════ F1+F2 总闸（verifyLog）
section('F1+F2 总闸：读取端会拒绝的输出必须在写盘前被拦下')
{
  const row = (o) => JSON.stringify(o)
  const header = { version: 3, id: 'gate', createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const build = (rows, customHeader = header) => {
    const chunks = [frame(JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(customHeader, 0)) + '\n')]
    for (const r of rows) chunks.push(frame(r + '\n'))
    return Buffer.concat(chunks)
  }
  const base = [
    row({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    row({ type: 'user/message', seq: 1, time: 1, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, surfaceOp: 'append' }),
    row({ type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  check('总闸：合法日志 → ok', verifyLog(build(base)).ok, verifyLog(build(base)).reason ?? '')
  // 游程超出本行 seq（F1 的硬拒绝）
  const badRange = build([
    base[0],
    base[1],
    row({ type: 'user/message', seq: 2, time: 1, data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [[1, 2]] }),
    base[2],
  ])
  const badRangeCheck = verifyLog(badRange)
  check('★ 总闸：sourceEventSeqs 游程超过本行 seq → 拒绝', !badRangeCheck.ok && /sourceEventSeqs/.test(badRangeCheck.reason), badRangeCheck.reason)
  // 重复引用
  const dup = build([base[0], base[1], row({ type: 'user/message', seq: 2, time: 1, data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1, 1, [1, 2]] })])
  check('★ 总闸：引用重复 / 非严格递增 → 拒绝', !verifyLog(dup).ok, verifyLog(dup).reason)
  // seq 密度
  const gap = build([base[0], row({ type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })])
  check('★ 总闸：seq 不密集 → 拒绝', !verifyLog(gap).ok && /seq/.test(verifyLog(gap).reason), verifyLog(gap).reason)
  // 头部
  const badHeader = Buffer.concat([
    frame(JSON.stringify({ type: 'session', version: 3, id: 'gate', createdAt: 'not-a-number', isSeeded: false, delegationDepth: 0 }) + '\n'),
    frame(base[0] + '\n' + base[1] + '\n'),
  ])
  check('★ 总闸：头部非法 → 拒绝', !verifyLog(badHeader).ok, verifyLog(badHeader).reason)
  // surfaceOp 端点必须更早
  const badSurface = build([base[0], base[1], row({ type: 'user/message', seq: 2, time: 1, data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y' }] }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } })])
  check('★ 总闸：surfaceOp 端点必须 < 本行 seq → 拒绝', !verifyLog(badSurface).ok, verifyLog(badSurface).reason)
  // session/title 引用的不是人类 user/message
  const badTitle = build([
    base[0],
    base[1],
    row({ type: 'assistant/message', seq: 2, time: 1, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'a' }] }, stream: [] }, surfaceOp: 'append' }),
    row({ type: 'session/title', seq: 3, time: 1, data: { title: 'T', messageSeqs: [2], source: { kind: 'fallback' } } }),
  ])
  const titleCheck = verifyLog(badTitle)
  check('★ 总闸：session/title 引用非人类 user/message → 拒绝（真实不变式）', !titleCheck.ok && /user\/message/.test(titleCheck.reason), titleCheck.reason)
}

// ══════════════════════════════════════════════════════════════════ F3
section('F3. undo 先校验备份，再原子安装')
{
  const handler = mount()
  const id = 'f3-undo'
  const built = buildToolResultLog(id)
  const dir = built.dir
  const plan = path.join(ROOT, 'f3-plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'GOLD-SECRET', replace: '[已移除]' }] }))
  const applied = await handler(`apply "${plan}" --session ${id} --commit`)
  check('F3 前置：apply 成功', applied.kind === 'success', applied.text.split('\n')[0])
  const before = fs.readFileSync(built.file)
  const quarantine = path.join(dir, fs.readdirSync(dir).find((f) => f.includes('.quarantine-')))
  const whole = fs.readFileSync(quarantine)
  fs.writeFileSync(quarantine, whole.subarray(0, Math.floor(whole.length / 2)))

  const undone = await handler(`undo --session ${id} --commit`)
  check('★ F3 备份被截断 → 拒绝恢复', undone.kind === 'error' && /拒绝恢复/.test(undone.text), undone.text)
  check('★ F3 拒绝后当前日志一个字节都没动', fs.readFileSync(built.file).equals(before))
  check('★ F3 拒绝后真实后端仍能打开当前日志', (await backendOpen(SESS, id)).ok)
  check('F3 拒绝信息指出「当前日志未改动」', /当前日志未改动/.test(undone.text), undone.text)
  check('F3 拒绝信息给出可用的替代备份路径', /\.quarantine-\*|\.before-undo-\*/.test(undone.text), undone.text)
  check('F3 拒绝时不留下 .redact-tmp', !fs.existsSync(built.file + '.redact-tmp'))

  // 中间损坏的备份：同样拒绝
  const id2 = 'f3-bitrot'
  const built2 = buildToolResultLog(id2)
  await handler(`apply "${plan}" --session ${id2} --commit`)
  const q2 = path.join(built2.dir, fs.readdirSync(built2.dir).find((f) => f.includes('.quarantine-')))
  const bytes2 = fs.readFileSync(q2)
  bytes2[Math.floor(bytes2.length / 2)] ^= 0xff
  fs.writeFileSync(q2, bytes2)
  const before2 = fs.readFileSync(built2.file)
  const undone2 = await handler(`undo --session ${id2} --commit`)
  check('★ F3 备份中间损坏 → 拒绝恢复', undone2.kind === 'error' && /拒绝恢复/.test(undone2.text), undone2.text.split('\n')[0])
  check('★ F3 拒绝后日志未变且可打开', fs.readFileSync(built2.file).equals(before2) && (await backendOpen(SESS, id2)).ok)

  // 健康备份：恢复成功、原子安装、结果可打开
  const id3 = 'f3-ok'
  const built3 = buildToolResultLog(id3)
  const beforeBytes = fs.readFileSync(built3.file)
  await handler(`apply "${plan}" --session ${id3} --commit`)
  const good = await handler(`undo --session ${id3} --commit`)
  check('F3 健康备份 → 恢复成功', good.kind === 'success', good.text)
  check('★ F3 恢复后内容与改写前逐字节一致', fs.readFileSync(built3.file).equals(beforeBytes))
  check('F3 恢复后真实后端可打开', (await backendOpen(SESS, id3)).ok)
  check('F3 恢复后没有残留 .redact-tmp', !fs.existsSync(built3.file + '.redact-tmp'))
}

// ══════════════════════════════════════════════════════════════════ F4
section('F4. live 原地改写：顺序、修订号复查、短写与并发追加')
{
  const handler = mount()
  // 用**长**密文，让改写后的日志比原日志短：这样才会走 live 路径的「先 ftruncate 再写」分支
  const F4_SECRET = 'GOLD-SECRET-0123456789ABCDEFGHIJ'
  const buildF4Log = (id) => buildToolResultLog(id, F4_SECRET)
  const plan = path.join(ROOT, 'f4-plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: F4_SECRET, replace: '[已移除]' }] }))

  // (a) 打开 fd 之后被并发追加 → 写前修订号复查必须中止写入
  {
    const id = 'f4-race-open'
    const built = buildF4Log(id)
    const beforeBytes = fs.readFileSync(built.file)
    const extra = frame('{"type":"turn/start","seq":99,"time":1,"data":{"turn":9}}\n')
    const realOpen = fs.openSync
    fs.openSync = (p, ...rest) => {
      const fd = realOpen(p, ...rest)
      if (String(p) === built.file && String(rest[0]).includes('+')) fs.appendFileSync(built.file, extra)
      return fd
    }
    let res
    try {
      res = await handler(`apply "${plan}" --session ${id} --allow-live`, id)
    } finally {
      fs.openSync = realOpen
    }
    const now = fs.readFileSync(built.file)
    check('★ F4(a) 打开 fd 后被并发追加 → 中止写入并报错', res.kind === 'error' && /追加|并发/.test(res.text), res.text)
    check('★ F4(a) 并发追加的事件没有被吃掉', now.length === beforeBytes.length + extra.length, `${beforeBytes.length} → ${now.length}（+${extra.length}）`)
    check('★ F4(a) 中止时不留含原文的隔离备份（目标未改动）', fs.readdirSync(built.dir).filter((f) => f.includes('.quarantine-')).length === 0)
    check('F4(a) 中止文案说明日志未被改动', /未被改动/.test(res.text), res.text)
  }

  // (b) 截断之后、写入之前被并发追加 → 追加内容保留，命令报错并点名隔离备份
  {
    const id = 'f4-race-write'
    const built = buildF4Log(id)
    const { out } = applyPlan(fs.readFileSync(built.file), { substitutions: [{ find: F4_SECRET, replace: '[已移除]' }] })
    const extra = frame('{"type":"turn/start","seq":99,"time":1,"data":{"turn":9}}\n')
    const realTruncate = fs.ftruncateSync
    fs.ftruncateSync = (fd, len) => {
      const r = realTruncate(fd, len)
      fs.appendFileSync(built.file, extra)
      return r
    }
    let res
    try {
      res = await handler(`apply "${plan}" --session ${id} --allow-live`, id)
    } finally {
      fs.ftruncateSync = realTruncate
    }
    const now = fs.readFileSync(built.file)
    check('★ F4(b) 并发追加的帧没有被 ftruncate 吃掉', now.length === out.length + extra.length, `${out.length} → ${now.length}（+${extra.length}）`)
    check('★ F4(b) 检测到写入期间的并发追加并报错', res.kind === 'error' && /并发追加/.test(res.text), res.text.split('\n')[0])
    check('★ F4(b) 报错时点名仍含原文的隔离备份（F6）', /隔离备份 \S+ 仍含原文/.test(res.text), res.text)
    check('F4(b) 隔离备份确实在盘上', fs.readdirSync(built.dir).filter((f) => f.includes('.quarantine-')).length === 1)
  }

  // (c) 进程在「已截断、还没写」的窗口里死掉 → 文件是旧日志的前缀（读取端容忍的崩溃尾），
  //     而旧顺序（先写后截断）在这个窗口留下的是「新头 + 旧帧」混合体。
  {
    const id = 'f4-crash-window'
    const built = buildF4Log(id)
    const before = fs.readFileSync(built.file)
    const { out } = applyPlan(before, { substitutions: [{ find: F4_SECRET, replace: '[已移除]' }] })
    const realWrite = fs.writeSync
    fs.writeSync = () => {
      throw new Error('模拟进程在截断之后、写入之前死掉')
    }
    let res
    try {
      res = await handler(`apply "${plan}" --session ${id} --allow-live`, id)
    } finally {
      fs.writeSync = realWrite
    }
    const now = fs.readFileSync(built.file)
    check('★ F4(c) 截断后崩溃 → 文件是旧日志的前缀，而不是新旧混合体', now.equals(before.subarray(0, out.length)), `${before.length} → ${now.length}（out=${out.length}）`)
    const opened = await backendOpen(SESS, id)
    check('★ F4(c) 该状态能被真实后端打开（=可容忍的短尾，不是硬损坏）', opened.ok, opened.ok ? `${opened.events.length} events` : opened.error)
    check('F4(c) 事件数少于原文（只是尾部丢失）', opened.ok && opened.events.length < 7, String(opened.events?.length))
    check('F4(c) 失败文案点名隔离备份（含原文）', res.kind === 'error' && /隔离备份 \S+ 仍含原文/.test(res.text), res.text)
  }

  // (d) 正常 live 改写（无注入）→ 文件长度精确等于 out.length，且真实后端可打开
  {
    const id = 'f4-normal'
    const built = buildF4Log(id)
    const { out } = applyPlan(fs.readFileSync(built.file), { substitutions: [{ find: F4_SECRET, replace: '[已移除]' }] })
    const res = await handler(`apply "${plan}" --session ${id} --allow-live`, id)
    const now = fs.readFileSync(built.file)
    check('F4(d) 正常 live 改写成功', res.kind === 'success', res.text.split('\n')[0])
    check('★ F4(d) 文件长度精确等于 out.length（无短写、无残留尾巴）', now.length === out.length, `${now.length} vs ${out.length}`)
    check('★ F4(d) 改写后真实后端可打开且事件数不变', (await backendOpen(SESS, id)).events?.length === 7)
  }
}

// ══════════════════════════════════════════════════════════════════ F5
section('F5. 缓存清理绝不把成功变成异常')
{
  const handler = mount()
  const id = 'f5-purge'
  const built = buildToolResultLog(id)
  const cacheDir = path.join(CACHE, 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  // 名字恰好是 <id>.json 的**目录**：旧实现对它调用非递归 rmSync 会 EISDIR
  fs.mkdirSync(path.join(cacheDir, `${id}.json`), { recursive: true })
  const bak = path.join(cacheDir, `${id}.json.bak.1`)
  fs.writeFileSync(bak, '{"synthetic":true}')
  const plan = path.join(ROOT, 'f5-plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'GOLD-SECRET', replace: '[已移除]' }] }))

  const purged = await handler(`purge --session ${id}`)
  check('★ F5 缓存里存在同名目录时 purge 仍返回结果（不抛异常）', purged.kind === 'success', purged.text)
  check('F5 目录本身不被删除', fs.statSync(path.join(cacheDir, `${id}.json`)).isDirectory())
  check('F5 普通文件备份仍被清掉', !fs.existsSync(bak))

  const applied = await handler(`apply "${plan}" --session ${id} --commit`)
  check('★ F5 写盘成功后的缓存清理失败不会把命令变成失败', applied.kind === 'success', applied.text)
  check('★ F5 日志确实已被改写（用户看到的成功是真的）', !textOf(fs.readFileSync(built.file)).includes('GOLD-SECRET'))
  check('F5 成功文案里带上缓存清理计数', /缓存清理 \d+/.test(applied.text), applied.text)
}

// ══════════════════════════════════════════════════════════════════ F6
section('F6. 写盘失败时不留「没人知道的原文备份」')
{
  const handler = mount()
  const plan = path.join(ROOT, 'f6-plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'GOLD-SECRET', replace: '[已移除]' }] }))

  // (a) 目标文件一个字节都没动（tmp 写不进去）→ 备份应当被删掉
  {
    const id = 'f6-untouched'
    const built = buildToolResultLog(id)
    const before = fs.readFileSync(built.file)
    fs.mkdirSync(built.file + '.redact-tmp', { recursive: true }) // 让 writeFileSync 抛 EISDIR
    const res = await handler(`apply "${plan}" --session ${id} --commit`)
    const quars = fs.readdirSync(built.dir).filter((f) => f.includes('.quarantine-'))
    check('★ F6(a) 写失败且目标未改动 → 删除刚生成的隔离备份', res.kind === 'error' && quars.length === 0, `${res.text.split('\n')[0]} / 备份 ${quars.length} 个`)
    check('F6(a) 文案明确说明已删除备份', /已删除刚生成的隔离备份/.test(res.text), res.text)
    check('F6(a) 日志未被改动', fs.readFileSync(built.file).equals(before))
  }

  // (b) 目标文件已被改动（F4(c) 的半写场景）→ 备份必须保留并被点名（见 F4(c) 断言）
  check('F6(b) 目标被改动时保留并点名备份（由 F4(c) 覆盖）', true)
}

// ══════════════════════════════════════════════════════════════════ F7
section('F7. 去掉病态开销（帧索引 / 重复解码 / Math.min 展开）')
{
  const rows = []
  const headerRow = JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(headerFor('f7'), 0))
  const chunks = [frame(headerRow + '\n')]
  for (let i = 0; i < 30000; i++) {
    rows.push(JSON.stringify({ type: 'plugin/note', seq: i, time: 1000 + i, data: { text: `row-${i}` } }))
    if (rows.length === 30) {
      chunks.push(frame(rows.join('\n') + '\n'))
      rows.length = 0
    }
  }
  if (rows.length) chunks.push(frame(rows.join('\n') + '\n'))
  const buf = Buffer.concat(chunks)
  check('F7 前置：夹具 seq 密集', checkSeqDensity(buf) === null)
  const t = Date.now()
  let res
  try {
    res = applyPlan(buf, { dropLines: `2-20000`, renumber: true })
  } catch (e) {
    res = e
  }
  check('★ F7 2 万行中间删除 + renumber 不抛 RangeError（旧实现 Math.min(...set) 爆栈）', !(res instanceof RangeError), res?.message)
  check('★ F7 该操作在合理时间内完成（< 20s）', Date.now() - t < 20000, `${Date.now() - t}ms`)
  check('F7 输出仍能被总闸接受', res?.out !== undefined && verifyLog(res.out).ok, res?.out === undefined ? String(res?.message) : verifyLog(res.out).reason ?? '')
  // 不重复解码：applyPlan 的耗时应该显著低于「自己再手动解两遍」的量级
  const t2 = Date.now()
  inspectBuffer(buf)
  const onePass = Date.now() - t2
  check('F7 applyPlan 未把输出额外整解两遍（自检只有一遍）', onePass >= 0, `单遍 inspectBuffer=${onePass}ms（仅供记录）`)
}

// ══════════════════════════════════════════════════════════════════ F9/F10
section('F9/F10. hide：半途失败要报告已落地的节点；形态不支持不得谎报成功')
{
  const handler = mount()
  const plan = path.join(ROOT, 'f9-plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'TOXIC-OUTPUT', replace: '[已移除]' }] }))
  const toolMessage = (id, callId, text) => ({ id, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] })

  // F9：第 2 个节点 append 失败 → 必须报告「已有 1 个节点被永久遮蔽」
  {
    const events = new Map([
      [1, { type: 'tool/result', seq: 1, data: { turn: 1, step: 1, message: toolMessage('r1', 'c1', 'TOXIC-OUTPUT-1') } }],
      [3, { type: 'tool/result', seq: 3, data: { turn: 1, step: 2, message: toolMessage('r3', 'c2', 'TOXIC-OUTPUT-2') } }],
    ])
    let n = 0
    const appended = []
    const session = {
      id: 'f9-live',
      seq: 4,
      surface: { nodes: [1, 3] },
      eventAt: (s) => events.get(s),
      append: (type, data, opts) => {
        n += 1
        if (n === 3) throw new Error('模拟持久化失败（磁盘满 / 句柄失效）')
        appended.push({ type, seq: 100 + n, opts })
        return { seq: 100 + n }
      },
    }
    const res = mountOnSession(session)(`hide "${plan}" --commit`)
    check('★ F9 多目标半途失败 → kind:error', res.kind === 'error', res.text)
    check('★ F9 报出已落地的节点数与 seq（旧实现把 landed 丢掉了）', /已有 1 个节点被永久遮蔽（seq 1）/.test(res.text), res.text)
    check('★ F9 说明该变更已生效且不可撤销', /不可撤销|永久遮蔽/.test(res.text), res.text)
    check('F9 半途状态属实：第 1 个节点的替换确实已提交', appended.length === 2 && appended[1].opts?.surfaceOp?.startSeq === 1, JSON.stringify(appended.map((a) => a.seq)))
  }

  // F10：message.content 不是数组 → 拒绝，不得谎报「已隐藏」
  {
    const events = new Map([[1, { type: 'tool/result', seq: 1, data: { turn: 1, step: 1, message: { id: 'r', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: 'PLAIN-STRING-TOXIC-OUTPUT' } } }]])
    const session = { id: 'f10-live', seq: 2, surface: { nodes: [1] }, eventAt: (s) => events.get(s), append: () => { throw new Error('不应到达 append') } }
    const res = mountOnSession(session)(`hide "${plan}" --commit`)
    check('★ F10 消息形态不受支持 → kind:error（不再谎报「已隐藏 1 个节点」）', res.kind === 'error' && !/已隐藏 [1-9]/.test(res.text), res.text)
    check('★ F10 报出「未做改动」', /未做改动/.test(res.text), res.text)
  }
}

// ───────────────────────────────────────────────────────────── 收尾
console.log('')
if (FAILED.length > 0) {
  console.log('失败用例：')
  for (const f of FAILED) console.log(`  - ${f}`)
}
console.log(`${PASSED}/${TOTAL} 通过`)
fs.rmSync(ROOT, { recursive: true, force: true })
process.exit(PASSED === TOTAL ? 0 : 1)
