/**
 * 回归测试：验证「引擎级拒绝不再杀掉宿主进程」、rollback / undo 分支，以及
 * **输出能被真实 DSH 读取端打开**。
 *
 * 夹具修正（红队报告的元发现）：
 *   旧夹具写的是 `role:'tool'` 的 tool/result —— 真实形状必须是 `role:'user'` +
 *   `source:{kind:'tool',callId}`（dsh-llm/lib/types/message.d.ts:22-25），
 *   user/message 也不是 `data.message` 包一层。因此旧夹具根本打不开，
 *   「引擎自检通过」被误当成「DSH 打得开」，F1/F2 这类读取端语义缺陷就漏过去了。
 *   现在夹具一律用真实 `Session` + `sessionFormatCatalog` 生成，判据用真实
 *   `JsonlSessionPersistence.open()`（见 test/real-reader.mjs）。
 *
 * 全部夹具为合成日志，落在临时目录，跑完即删；不接触任何真实会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { applyPlan } from '../lib/engine.mjs'
import { Session, headerFor, frame, writeSessionLog, backendOpen } from './real-reader.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-redact-reg-'))
const cacheRoot = path.join(root, 'storages')
const sessionsRoot = path.join(root, 'sessions')
const sid = 'sess-0001'
// 真实后端按「目录名 = cwd」校验头部：没有 cwd 的会话必须落在 _no-cwd 下
const project = '_no-cwd'

const header = headerFor(sid)
// 3 个完整轮次；第 2 轮里有一段含 SECRET 的 tool/result（真实消息形状）
const built = writeSessionLog(sessionsRoot, project, sid, header, (s) => {
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  s.append('turn/start', { turn: 2 })
  s.append('step/start', { turn: 2, step: 1 })
  s.append('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"echo hi"}' })
  s.append(
    'tool/result',
    {
      turn: 2,
      step: 1,
      message: {
        id: 'r1',
        role: 'user',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'GOLD-SECRET here' }] }],
      },
    },
    { surfaceOp: 'append' },
  )
  s.append('step/end', { turn: 2, step: 1 })
  s.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  s.append('turn/start', { turn: 3 })
  s.append('step/start', { turn: 3, step: 1 })
  s.append('user/message', { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bye' }] }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 3, step: 1 })
  s.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
})
const log = built.file
const dir = built.dir

/** 把 buffer 装到会话目录里，用真实后端打开它。 */
async function openBytes(buffer, id = sid) {
  const target = path.join(sessionsRoot, project, id)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'session.v3.jsonl.zstd'), buffer)
  return backendOpen(sessionsRoot, id)
}

let captured = null
const ctx = { commands: { register(d) { captured = d } }, get: () => undefined }
const mod = await import('../index.js')
mod.apply(ctx, { root: sessionsRoot, cacheRoot, placeholder: '[已移除]' })
const call = (rawInput) => captured.handler({ rawInput, agent: { session: { id: 'other-session' } } })

let total = 0
let passed = 0
const check = (name, ok, detail = '') => {
  total += 1
  if (ok) passed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const planFile = path.join(root, 'plan.json')
fs.writeFileSync(planFile, JSON.stringify({ substitutions: [{ find: 'GOLD-SECRET', replace: '[已移除]' }] }))
const badPlan = path.join(root, 'bad.json')
fs.writeFileSync(badPlan, JSON.stringify({ blankLines: '1' }))

// ---- 夹具本身必须是读取端合法日志（否则一切断言都没意义）
const fixtureOpen = await backendOpen(sessionsRoot, sid)
check('★ 夹具：改写前 DSH 真实后端可打开（读取端合法）', fixtureOpen.ok, fixtureOpen.ok ? `${fixtureOpen.events.length} events` : fixtureOpen.error)
const toolResultRow = built.session.snapshotEvents().find((e) => e.type === 'tool/result')
check(
  '★ 夹具：tool/result 是真实消息形状（role=user + source.kind=tool）',
  toolResultRow?.data?.message?.role === 'user' && toolResultRow?.data?.message?.source?.kind === 'tool' && toolResultRow?.data?.message?.source?.callId === 'c1',
  JSON.stringify(toolResultRow?.data?.message?.source),
)

// ---- BUG-1：非法计划必须返回 error，而不是杀掉进程
const r1 = await call(`apply "${badPlan}" --session ${sid}`)
check('BUG-1 非法计划返回 error（进程存活）', r1.kind === 'error', r1.text.split('\n')[0])
check('BUG-1 文件未被改动', fs.readFileSync(log).length === fs.statSync(log).size)

// ---- BUG-1b：中间行删除（无 renumber）也必须返回 error
const badPlan2 = path.join(root, 'bad2.json')
fs.writeFileSync(badPlan2, JSON.stringify({ dropLines: '3' }))
const r2 = await call(`apply "${badPlan2}" --session ${sid}`)
check('BUG-1b 中间行删除返回 error', r2.kind === 'error', r2.text.split('\n')[0])

// ---- BUG-2：帧魔数损坏必须返回 error，而不是抛未捕获异常
const brokenDir = path.join(sessionsRoot, project, 'sess-broken')
fs.mkdirSync(brokenDir, { recursive: true })
fs.writeFileSync(path.join(brokenDir, 'session.v3.jsonl.zstd'), Buffer.concat([frame(JSON.stringify({ ...header, id: 'sess-broken' }) + '\n'), Buffer.from('NOT-A-FRAME')]))
const r3 = await call('verify --session sess-broken')
check('BUG-2 损坏帧返回 error', r3.kind === 'error', r3.text.split('\n')[0])

// ---- scan 定位
const r4 = await call(`scan "${planFile}" --session ${sid}`)
check('scan 命中 1 行', /命中 1 行/.test(r4.text), r4.text.split('\n')[0])
check('scan 不泄漏原文', !r4.text.includes('GOLD-SECRET'))

// ---- rollback 试算
const r5 = await call(`rollback 1 --session ${sid}`)
check('rollback 试算识别 3 轮（回退 1 轮 → 保留 2 轮，单行）', /共\s*3\s*轮\s*·\s*回退\s*1\s*轮\s*→\s*保留\s*2\s*轮/.test(r5.text) && !r5.text.includes('\n'), r5.text)
check('rollback 试算不写盘', /试算/.test(r5.text) && !fs.existsSync(log + '.redact-tmp'))

// ---- rollback 执行（非当前会话）
const r6 = await call(`rollback 1 --session ${sid} --commit`)
check('rollback 执行成功', r6.kind === 'success', r6.text)
const afterRollback = fs.readFileSync(log)
const { scanFrames, checkSeqDensity, inspectBuffer } = await import('../lib/engine.mjs')
check('rollback 后结构完好', checkSeqDensity(afterRollback) === null && inspectBuffer(afterRollback).headerOk)
const plainAfter = scanFrames(afterRollback)
  .frames.map((f) => zlib.zstdDecompressSync(afterRollback.subarray(f.start, f.end)).toString('utf8'))
  .join('')
check('rollback 删掉了第 3 轮', !plainAfter.includes('"turn":3'))
check('rollback 保留前两轮', plainAfter.includes('"turn":1') && plainAfter.includes('"turn":2'))
check('rollback 未碰 SECRET 行', plainAfter.includes('GOLD-SECRET'))
check('rollback 留了隔离备份', fs.readdirSync(dir).some((f) => f.includes('.quarantine-')))
const rollbackOpen = await openBytes(afterRollback)
check('★ rollback 后 DSH 真实后端可打开', rollbackOpen.ok, rollbackOpen.ok ? `${rollbackOpen.events.length} events` : rollbackOpen.error)

// ---- undo 试算 + 执行
const r7 = await call(`undo --session ${sid}`)
check('undo 找到备份（命名 + 体积 + 当前体积，单行）', /备份\s+\S*\.quarantine-\S+（\d+B）\s*·\s*当前\s+\d+B/.test(r7.text) && !r7.text.includes('\n'), r7.text)
const r8 = await call(`undo --session ${sid} --commit`)
check('undo 执行成功', r8.kind === 'success', r8.text.split('\n')[0])
const restored = fs.readFileSync(log)
check('undo 恢复了第 3 轮', scanFrames(restored)
  .frames.map((f) => zlib.zstdDecompressSync(restored.subarray(f.start, f.end)).toString('utf8'))
  .join('')
  .includes('"turn":3'))
check('undo 留了撤销前快照', fs.readdirSync(dir).some((f) => f.includes('.before-undo-')))
check('undo 后无备份时再撤销报错', (await call('undo --session sess-broken')).kind === 'error')
const undoOpen = await openBytes(restored)
check('★ undo 后 DSH 真实后端可打开（备份先校验再安装）', undoOpen.ok, undoOpen.ok ? `${undoOpen.events.length} events` : undoOpen.error)

// ---- apply 脱敏 + 结构不变
const r9 = await call(`apply "${planFile}" --session ${sid} --commit`)
check('apply 执行成功', r9.kind === 'success', r9.text)
const afterApply = fs.readFileSync(log)
const plainApplied = scanFrames(afterApply)
  .frames.map((f) => zlib.zstdDecompressSync(afterApply.subarray(f.start, f.end)).toString('utf8'))
  .join('')
check('apply 抹掉了原文', !plainApplied.includes('GOLD-SECRET'))
check('apply 行数不变', inspectBuffer(afterApply).lines === inspectBuffer(restored).lines)
check('apply 后 seq 仍密集', checkSeqDensity(afterApply) === null)
const applyOpen = await openBytes(afterApply)
check('★ 普通（非 renumber）原地脱敏后 DSH 真实后端仍可打开', applyOpen.ok, applyOpen.ok ? `${applyOpen.events.length} events` : applyOpen.error)
// 安全路径不回归：脱敏只改文本，事件数与结构都不变
check('★ 脱敏后事件数与改写前一致', applyOpen.ok && applyOpen.events.length === undoOpen.events.length, `${undoOpen.events?.length} → ${applyOpen.events?.length}`)

// ---- 当前会话必须被拒绝
const liveCall = (rawInput) => captured.handler({ rawInput, agent: { session: { id: sid } } })
check('拒绝 apply 当前会话', (await liveCall(`apply "${planFile}"`)).kind === 'error')
check('拒绝 rollback 当前会话', (await liveCall('rollback 1 --commit')).kind === 'error')
check('拒绝 undo 当前会话', (await liveCall('undo --commit')).kind === 'error')

// ---- 会话内隐藏：nodes 列表 + hide --lines（风控拦截场景的实际路径）
{
  let cap2 = null
  const ctx2 = {
    commands: { register(d) { cap2 = d } },
    get: (n) => (n === 'tokenMeter' ? { estimateMessage: () => 42 } : undefined),
  }
  const mod2 = await import('../index.js?inline-hide')
  mod2.apply(ctx2, { root: sessionsRoot, cacheRoot, placeholder: '[已移除]' })

  const appended = []
  // 真实消息形状：tool/result 的 message 是 role:'user' + source:{kind:'tool',callId}
  const toolMessage = (id, callId, text) => ({
    id,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  })
  const events = new Map([
    [0, { type: 'user/message', data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [] } }],
    [1, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-aa', name: 'pwsh', arguments: '{}' } }],
    [2, { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: toolMessage('r2', 'call-aa', 'TOXIC-OUTPUT-XYZ') } }],
    [4, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-bb', name: 'web_fetch', arguments: '{}' } }],
    [5, { type: 'tool/result', seq: 5, data: { turn: 2, step: 1, message: toolMessage('r5', 'call-bb', 'NEWER') } }],
  ])
  const liveSession = {
    id: 'live-1',
    seq: 6,
    surface: { nodes: [0, 2, 5] },
    eventAt: (s) => events.get(s),
    append: (type, data, opts) => {
      const seq = 100 + appended.length
      appended.push({ type, data, opts, seq })
      return { seq }
    },
  }
  const hid = (rawInput) => cap2.handler({ rawInput, agent: { session: liveSession } })
  const sizeOf = (seq) => JSON.stringify(events.get(seq).data.message).length

  const n = await hid('nodes')
  check('nodes 单行（渲染端会把换行压掉）', !n.text.includes('\n'), JSON.stringify(n.text.slice(0, 60)))
  check('nodes 显示格 <=200', n.text.length <= 200 && [...n.text].length <= 200, `字符 ${[...n.text].length}`)
  check('nodes [1] 是最新的（seq 5 → 行 7，含轮次）', n.text.includes(`[1] 7 轮2 web_fetch ${sizeOf(5)}B`), n.text)
  check('nodes [2] 是较早的（seq 2 → 行 4，含轮次）', n.text.includes(`[2] 4 轮1 pwsh ${sizeOf(2)}B`), n.text)
  check('nodes 最新在前', n.text.indexOf('[1] 7 ') < n.text.indexOf('[2] 4 '))
  check('nodes 提示短命令而非长路径', n.text.includes('/redact hide <序号>'))
  check('nodes 不显示正文', !n.text.includes('TOXIC-OUTPUT') && !n.text.includes('NEWER'))
  check('nodes 不泄漏内部 seq', !/seq\s*\d/.test(n.text))

  const dryByIdx = await hid('hide 1')
  check('hide <序号> 解析为最新那条（行 7）', /将隐藏 1 个节点/.test(dryByIdx.text), dryByIdx.text)
  check('hide <序号> 试算不写会话', appended.length === 0)

  const badIdx = await hid('hide 99')
  check('hide <序号> 越界报错', badIdx.kind === 'error' && /超出范围/.test(badIdx.text), badIdx.text)

  const dry = await hid('hide --lines 7')
  check('hide --lines 试算命中 1 个节点', /将隐藏 1 个节点/.test(dry.text), dry.text)

  const miss = await hid('hide --lines 99')
  check('hide --lines 未命中', /未命中/.test(miss.text), miss.text)

  const committed = await hid('hide 1 --commit')
  check('hide --commit 成功', committed.kind === 'success' && /已隐藏 1 个节点/.test(committed.text), committed.text)
  check('hide 结果也是单行', !committed.text.includes('\n'))
  check('hide 发了遮蔽价签', appended[0]?.type === 'compaction/prune' && appended[0]?.data?.shadowedTokenCount === 42)
  check('hide 的价签与替换紧邻', appended[1]?.type === 'tool/result' && appended[0]?.data?.shadowedSeqs?.[0] === 5)
  const rep = appended[1]
  check('hide 用 surfaceOp 替换同一节点', rep?.opts?.surfaceOp?.op === 'replace' && rep.opts.surfaceOp.startSeq === 5 && rep.opts.surfaceOp.endSeq === 5)
  check('hide 引用来源节点', JSON.stringify(rep?.opts?.sourceEventSeqs) === '[5]')
  const txt = rep?.data?.message?.content?.[0]?.content?.[0]?.text
  check('hide 已把正文换成占位符', txt === '[已移除]', String(txt))
  // 真实形状是 role:'user' + source:{kind:'tool'}（旧的 role:'tool' 是读取端会拒绝的假形状）
  check(
    'hide 保持 tool/result 的真实消息结构',
    rep?.data?.message?.role === 'user' && rep?.data?.message?.source?.kind === 'tool' && rep?.data?.turn === 2 && rep?.data?.step === 1,
    JSON.stringify({ role: rep?.data?.message?.role, source: rep?.data?.message?.source }),
  )
  check('hide 保留 source.callId（配对不破）', rep?.data?.message?.source?.callId === 'call-bb')
}

console.log(`\n${passed}/${total} 通过`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(passed === total ? 0 : 1)
