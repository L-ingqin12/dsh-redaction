/**
 * P7 — purgeCache 爆炸半径 + 失败路径残留物。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Session, headerFor, writeLog, ROOT } from './fixture.mjs'

const mod = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js').href)
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })
const HOME = path.join(os.tmpdir(), 'rt-redact', 'home7')
const CACHE = path.join(HOME, 'storages')

let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

function mkSession(id) {
  const s = Session.create(id, undefined, headerFor(id), undefined)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return writeLog(id, headerFor(id), s.snapshotEvents())
}

const SID = 'target-session'
mkSession(SID)
const proj = path.join(CACHE, 'session_projcache', 'sessions')
fs.mkdirSync(proj, { recursive: true })
const files = {
  mine: path.join(proj, `${SID}.json`),
  mineBak: path.join(proj, `${SID}.json.bak.20250101`),
  other: path.join(proj, 'other-session.json'),
  sibling: path.join(proj, `${SID}-sibling.json`),
  outside: path.join(CACHE, 'session_projcache', 'important.json'),
}
for (const [k, p] of Object.entries(files)) fs.writeFileSync(p, k)
fs.mkdirSync(path.join(proj, `${SID}-dir.json`), { recursive: true })

let captured = null
mod.apply({ commands: { register: (d) => { captured = d } }, get: () => undefined }, { root: ROOT, cacheRoot: CACHE })
const call = (raw) => captured.handler({ rawInput: raw, agent: { session: { id: SID } } })

// ---- A. 正常清理只动自己的文件
{
  const r = await call(`purge --session ${SID}`)
  console.log(`      → ${r.text.split('\n')[0]}`)
  assert('A. 只删掉本会话的 .json / .json.bak.*', !fs.existsSync(files.mine) && !fs.existsSync(files.mineBak) && fs.existsSync(files.other) && fs.existsSync(files.sibling) && fs.existsSync(files.outside))
}

// ---- B. 前缀/同名兄弟不能被误删
{
  fs.writeFileSync(files.mine, 'x'); fs.writeFileSync(files.mineBak, 'x')
  await call(`purge --session ${SID}`)
  assert('B. 兄弟 id（前缀相同）不受影响', fs.existsSync(files.sibling))
}

// ---- C. 路径穿越 / 特殊字符 session id
{
  const sentinel = path.join(os.tmpdir(), 'rt-redact', 'SENTINEL.json')
  fs.writeFileSync(sentinel, 'must survive')
  for (const evil of ['..', '../..', '..\\..\\rt-redact', '*', 'target-session/*', '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/AppData/Local/Temp/rt-redact/SENTINEL', 'target-session.json']) {
    const r = await call(`purge --session "${evil}"`)
    assert(`C. session id "${evil}" 不能删除 cache 之外的文件`, fs.existsSync(sentinel), r.text.split('\n')[0])
  }
  const inside = fs.readdirSync(proj)
  console.log(`      → 目录内容: ${inside.join(' | ')}`)
}

// ---- D. 目录名恰好等于 <sid>.json 时 purge 是否会抛未捕获异常
{
  fs.rmSync(files.mine, { force: true })
  fs.mkdirSync(files.mine, { recursive: true })
  let r
  try { r = await call(`purge --session ${SID}`) } catch (e) { r = { kind: 'THREW', text: `${e.constructor.name}: ${e.message}` } }
  console.log(`      → 返回 kind=${r.kind} text=${String(r.text).slice(0, 130)}`)
  assert('D. 缓存里存在同名目录时 purge 不抛未捕获异常', r.kind !== 'THREW', r.text)
  fs.rmSync(files.mine, { recursive: true, force: true })
}

// ---- E. 失败路径残留：rename 失败时 .redact-tmp 是否留下
{
  const id = 'rt-tmp-leak'
  const file = mkSession(id)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p7plan.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'hi', replace: 'x' }] }))
  // 让 writeFileSync(tmp) 失败：把 tmp 预建成目录
  fs.mkdirSync(file + '.redact-tmp', { recursive: true })
  const r = await call(`apply "${plan}" --session ${id} --commit`)
  console.log(`      → 返回: ${String(r.text).split('\n')[0]}`)
  const quars = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.quarantine-'))
  console.log(`      → 残留隔离备份 ${quars.length} 个（含原文），.redact-tmp 是目录=${fs.statSync(file + '.redact-tmp').isDirectory()}`)
  assert('E. 写入失败时不留含原文的隔离备份', quars.length === 0, `实际 ${quars.length} 个`)
}

// ---- F. 写盘成功之后 purgeCache 抛错 → 命令报失败但日志已被改写
{
  const id = 'rt-post-write'
  const file = mkSession(id)
  const dir = path.dirname(file)
  const before = fs.readFileSync(file)
  const plan = path.join(os.tmpdir(), 'rt-redact', 'p7plan2.json')
  fs.writeFileSync(plan, JSON.stringify({ substitutions: [{ find: 'hi', replace: 'REDACTED-TEXT' }] }))
  fs.mkdirSync(path.join(proj, `${id}.json`), { recursive: true })
  let r
  try { r = await call(`apply "${plan}" --session ${id} --commit`) } catch (e) { r = { kind: 'THREW', text: `${e.constructor.name}: ${e.message}` } }
  const changed = !fs.readFileSync(file).equals(before)
  const quars = fs.readdirSync(dir).filter((f) => f.includes('.quarantine-'))
  console.log(`      → 返回 kind=${r.kind}；日志是否已被改写=${changed}；隔离备份=${quars.length} 个`)
  assert('F. purgeCache 抛错时命令仍返回结果（不是异常逃出）', r.kind !== 'THREW', r.text)
  assert('F. 若命令报失败，日志不应已被改写（要么都不做，要么都告知）', !(r.kind === 'error' && changed),
    `kind=${r.kind} changed=${changed}（用户看到失败，但盘上已改写并留下含原文备份）`)
  fs.rmSync(path.join(proj, `${id}.json`), { recursive: true, force: true })
}

console.log(fail === 0 ? '\nP7: 未发现问题' : `\nP7: ${fail} 条断言失败`)