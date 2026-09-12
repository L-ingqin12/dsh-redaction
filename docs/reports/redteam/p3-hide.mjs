/**
 * P3 — hide 在「活会话」上的半途失败 / 静默无操作 / 价格事件孤儿。
 * 用真实 dsh-session 的 Session 作为活会话，用真实 dsh-token-meter 的折叠函数复核。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Session, headerFor, imp } from './fixture.mjs'

const { foldSurfaceProjection } = await imp('dsh-token-meter/lib/types/surface-projection.js')
const mod = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js').href)

let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const SECRET = 'TOXIC-OUTPUT'

function liveSession(id) {
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' })
  s.append('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: SECRET + '-1' }] }] } }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: '{}' })
  s.append('tool/result', { turn: 1, step: 2, message: { id: 'r2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: SECRET + '-2' }] }] } }, { surfaceOp: 'append' })
  return s
}

function mkHandler(ctxExtra = {}) {
  let captured = null
  const ctx = { commands: { register: (d) => { captured = d } }, get: (n) => (n === 'tokenMeter' ? { estimateMessage: () => 42 } : undefined), ...ctxExtra }
  mod.apply(ctx, { root: path.join(os.tmpdir(), 'rt-redact', 'root3'), cacheRoot: path.join(os.tmpdir(), 'rt-redact', 'cache3'), placeholder: '[已移除]' })
  return captured.handler
}

const textOf = (ev) => ev?.data?.message?.content?.[0]?.content?.[0]?.text

// ============================================ A. 多目标：第 2 个 append 失败 → 半途变更
{
  const inner = liveSession('rt-hide-A')
  const appended = []
  let n = 0
  const wrapped = {
    id: inner.id,
    get seq() { return inner.seq },
    get surface() { return inner.surface },
    eventAt: (q) => inner.eventAt(q),
    append: (type, data, opts) => {
      n += 1
      if (n === 4) throw new Error('模拟持久化失败（磁盘满 / 句柄失效）')
      const ev = inner.append(type, data, opts)
      appended.push(ev)
      return ev
    },
  }
  const handler = mkHandler()
  console.log(`      [debug] typeof mod.apply=${typeof mod.apply} typeof handler=${typeof handler}`)
  fs.mkdirSync(path.join(os.tmpdir(), 'rt-redact', 'root3'), { recursive: true })
  const planFile = path.join(os.tmpdir(), 'rt-redact', 'p3plan.json')
  fs.writeFileSync(planFile, JSON.stringify({ substitutions: [{ find: SECRET, replace: '[已移除]' }] }))
  const r = handler({ rawInput: `hide "${planFile}" --commit`, agent: { session: wrapped } })
  console.log(`      → 返回: kind=${r.kind} text=${r.text}`)
  console.log(`      → 已提交事件: ${appended.map((e) => e.type + '#' + e.seq).join(', ')}`)
  assert('A. 命令报告失败', r.kind === 'error')
  assert('A. 失败信息告知用户「已经有节点被改动」（半途状态）', /已.*(隐藏|改动|替换)/.test(r.text) || /第 \d+ 个/.test(r.text), r.text)
  const hidden = inner.snapshotEvents().filter((e) => textOf(e) === '[已移除]').length
  assert('A. 活会话里已有节点被改写（半途变更已生效）', hidden > 0, `已隐藏节点数=${hidden}`)
  console.log(`      → 活 surface 节点数=${[...inner.surface.nodes].length}`)

  // 孤儿价格事件对真实 token-meter 折叠的影响
  let claim
  let thrown
  try {
    for (const ev of inner.snapshotEvents()) claim = foldSurfaceProjection(claim, ev).claim
  } catch (e) { thrown = e.message }
  console.log(`      → 真实 token-meter 折叠重放：${thrown === undefined ? '未抛错（孤儿 claim 被下一个事件丢弃）' : '抛错 ' + thrown}`)
}

// ============================================ B. 目标被改动后再次 hide：是否重复追加 / 破坏
{
  const s = liveSession('rt-hide-B')
  const handler = mkHandler()
  const planFile = path.join(os.tmpdir(), 'rt-redact', 'p3plan.json')
  const r1 = handler({ rawInput: `hide "${planFile}" --commit`, agent: { session: s } })
  const r2 = handler({ rawInput: `hide "${planFile}" --commit`, agent: { session: s } })
  console.log(`      → 第二次 hide: ${r2.text}`)
  assert('B. 第二次 hide 不重复改写（幂等，未命中）', /未命中/.test(r2.text), r2.text)

  // 关键：磁盘上的原文是否仍在？(hide 只改内存)
  const rows = s.snapshotEvents()
  const stillThere = JSON.stringify(rows).includes(SECRET)
  console.log(`      → 会话事件里是否仍有原文: ${stillThere}（hide 的已知语义：只移出模型视野）`)
  console.log(`      → 活 surface 节点数=${[...s.surface.nodes].length}，事件总数=${rows.length}`)
}

// ============================================ C. tool/result 结构异常时是否静默「假装隐藏」
{
  const s = liveSession('rt-hide-C')
  // 造一个 content 不是数组的 tool/result（第三方/损坏日志可能出现）
  const weird = {
    id: s.id,
    seq: s.seq,
    surface: { nodes: [4] },
    eventAt: () => ({ type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { id: 'r', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: 'PLAIN-STRING-' + SECRET } } }),
    append: () => ({ seq: 99 }),
  }
  const handler = mkHandler()
  const planFile = path.join(os.tmpdir(), 'rt-redact', 'p3plan.json')
  const r = handler({ rawInput: `hide "${planFile}" --commit`, agent: { session: weird } })
  console.log(`      → 返回: ${r.text}`)
  assert('C. content 为字符串时不会谎报「已隐藏」', !/已隐藏 [1-9]/.test(r.text), r.text)
}

// ============================================ D. JSON.stringify 抛错（BigInt / 循环）时的行为
{
  const s = liveSession('rt-hide-D')
  const cyc = { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [] }] }
  cyc.self = cyc
  const weird = {
    id: s.id,
    seq: s.seq,
    surface: { nodes: [4] },
    eventAt: () => ({ type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: cyc } }),
    append: () => { throw new Error('不应到达 append') },
  }
  const handler = mkHandler()
  const planFile = path.join(os.tmpdir(), 'rt-redact', 'p3plan.json')
  let r
  try { r = handler({ rawInput: `hide "${planFile}" --commit`, agent: { session: weird } }) } catch (e) { r = { kind: 'THREW', text: e.message } }
  console.log(`      → 返回: kind=${r.kind} text=${r.text}`)
  assert('D. 循环引用不会把异常抛出 handler', r.kind !== 'THREW', r.text)
}

console.log(fail === 0 ? '\nP3: 未发现半途变更类缺陷' : `\nP3: ${fail} 条断言失败`)
