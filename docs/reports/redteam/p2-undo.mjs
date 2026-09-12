/**
 * P2 — 隔离备份 / undo / 时间戳碰撞。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Session, sessionFormatCatalog, headerFor, writeLog, backendOpen, frame, ROOT } from './fixture.mjs'

const CACHE = path.join(os.tmpdir(), 'rt-redact', 'storages2')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.rmSync(CACHE, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

const mod = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js').href)
let captured = null
const ctx = { commands: { register: (d) => { captured = d } }, get: () => undefined }
mod.apply(ctx, { root: ROOT, cacheRoot: CACHE, placeholder: '[已移除]' })
const call = (raw, sid = 'other') => captured.handler({ rawInput: raw, agent: { session: { id: sid } } })

let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

function build(id, secret = 'GOLD-SECRET') {
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' })
  s.append('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: secret }] }] } }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return writeLog(id, H, s.snapshotEvents())
}

// ============================================ A. undo 不做任何校验就覆盖健康日志
{
  const id = 'rt-undo-bad'
  const file = build(id)
  const dir = path.dirname(file)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p2plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'GOLD-SECRET', replace: '[已移除]' }] }))

  const r1 = await call(`apply "${plan}" --session ${id} --commit`)
  assert('A. apply 成功', r1.kind === 'success', r1.text.split('\n')[0])
  const back = fs.readdirSync(dir).filter((f) => f.includes('.quarantine-'))
  assert('A. 生成了隔离备份', back.length === 1, back.join(','))
  const q = path.join(dir, back[0])
  const goodSize = fs.statSync(file).size
  assert('A. 脱敏后日志结构完好', (await backendOpen(id, ROOT)).ok)

  // 模拟「备份只写了一半」（copyFileSync 中途失败 / 断电 / 被截断）
  const whole = fs.readFileSync(q)
  fs.writeFileSync(q, whole.subarray(0, Math.floor(whole.length / 2)))
  console.log(`      → 备份被截断: ${whole.length} → ${fs.statSync(q).size} 字节`)

  const r2 = await call(`undo --session ${id} --commit`)
  assert('A. undo 报告成功（没有校验备份）', r2.kind === 'success', r2.text.split('\n')[0])
  const nowSize = fs.statSync(file).size
  assert('A. 当前日志被坏备份覆盖', nowSize !== goodSize, `${goodSize} → ${nowSize}`)
  const opened = await backendOpen(id, ROOT)
  const lost = opened.ok ? (r1.text.includes('换1') ? '静默丢失事件' : '') : ''
  console.log(`      → 截断备份被当成崩溃尾读取：ok=${opened.ok} events=${opened.events?.length ?? '-'} ${lost}`)
  const aside = fs.readdirSync(dir).filter((f) => f.includes('.before-undo-'))
  console.log(`      → 撤销前状态另存为 ${aside.join(',')}（需要人工改名才能救回）`)
}

// ============================================ A2. undo 覆盖上一个「中间损坏」的备份 → 硬拒绝
{
  const id = 'rt-undo-bitrot'
  const file = build(id)
  const dir = path.dirname(file)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p2plan.json')
  await call(`apply "${plan}" --session ${id} --commit`)
  const q = path.join(dir, fs.readdirSync(dir).find((f) => f.includes('.quarantine-')))
  const whole = fs.readFileSync(q)
  whole[Math.floor(whole.length / 2)] ^= 0xff
  fs.writeFileSync(q, whole)
  const r = await call(`undo --session ${id} --commit`)
  assert('A2. undo 报告成功', r.kind === 'success', r.text.split('\n')[0])
  const opened = await backendOpen(id, ROOT)
  assert('A2. 覆盖后 DSH 无法打开该会话（硬损坏）', !opened.ok, opened.error ?? '仍可打开')
}

// ============================================ B. 日志缺失时 undo 无法恢复（注释与实现不符）
{
  const id = 'rt-undo-missing'
  const file = build(id)
  const dir = path.dirname(file)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p2plan.json')
  await call(`apply "${plan}" --session ${id} --commit`)
  const q = fs.readdirSync(dir).find((f) => f.includes('.quarantine-'))
  assert('B. 备份存在', q !== undefined)
  fs.rmSync(file)
  const r = await call(`undo --session ${id} --commit`)
  assert('B. 日志缺失时 undo 仍能恢复（实现承诺）', r.kind === 'success', r.text.split('\n')[0])
}

// ============================================ C. 毫秒时间戳碰撞：备份被覆盖
{
  const id = 'rt-collide'
  const file = build(id)
  const dir = path.dirname(file)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p2plan.json')
  const N = 40
  let ok = 0
  for (let i = 0; i < N; i++) {
    const r = await call(`apply "${plan}" --session ${id} --commit`)
    if (r.kind === 'success') ok += 1
  }
  const backs = fs.readdirSync(dir).filter((f) => f.includes('.quarantine-'))
  console.log(`      → ${N} 次 apply 全部成功=${ok}，隔离备份文件数=${backs.length}`)
  assert(`C. ${N} 次脱敏产出 ${N} 个互不覆盖的备份`, backs.length === N, `实际 ${backs.length} 个 → 有 ${N - backs.length} 份原始状态被覆盖`)
}

// ============================================ D. copyFileSync 是否保留 mtime（排序依据）
{
  const a = path.join(os.tmpdir(), 'rt-redact', 'mt-a.bin')
  const b = path.join(os.tmpdir(), 'rt-redact', 'mt-b.bin')
  fs.writeFileSync(a, 'x')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(a, old, old)
  fs.copyFileSync(a, b)
  const same = Math.abs(fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) < 1
  console.log(`      → copyFileSync 保留源 mtime: ${same}（源 ${fs.statSync(a).mtime.toISOString()}，副本 ${fs.statSync(b).mtime.toISOString()}）`)
}

console.log(fail === 0 ? '\nP2: 全部断言通过（=未发现问题）' : `\nP2: ${fail} 条断言失败（=发现真实缺陷）`)
