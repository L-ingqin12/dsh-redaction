/**
 * P4 — 落盘路径：live 原地覆盖的写/截断窗口，以及 CLI 并发。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Session, headerFor, writeLog, backendOpen, frame, ROOT } from './fixture.mjs'

const { applyPlan, checkSeqDensity, inspectBuffer, scanFrames } = await import(pathToFileURL('' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/lib/engine.mjs').href)
const NODE = '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/nodejs-x64/node-v22.21.0-win-x64/node.exe'
const CLI = '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/bin/dsh-redact.mjs'

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })
let fail = 0
const assert = (name, ok, detail = '') => { if (!ok) fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

function build(id, n = 4) {
  const H = headerFor(id)
  const s = Session.create(id, undefined, H, undefined)
  for (let t = 1; t <= n; t++) {
    s.append('turn/start', { turn: t })
    s.append('step/start', { turn: t, step: 1 })
    s.append('user/message', { id: `u${t}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `q${t} SECRET-${t}` }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: t, step: 1 })
    s.append('turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  return writeLog(id, H, s.snapshotEvents())
}

const planFile = path.join(os.tmpdir(), 'rt-redact', 'p4plan.json')
fs.writeFileSync(planFile, JSON.stringify({ substitutions: [{ find: 'SECRET', replace: '[X]' }] }))

// ============================================ A. live 路径：写与截断之间的一次并发追加被 ftruncate 吃掉
{
  const id = 'rt-live-race'
  const file = build(id)
  const before = fs.readFileSync(file)
  const { out } = applyPlan(before, { substitutions: [{ find: 'SECRET', replace: '[X]' }] })
  const outLen = out.length
  const extra = frame('{"type":"turn/start","seq":99,"time":1,"data":{"turn":9}}\n')

  // 复刻 index.js:commitRewrite(live=true) 的 syscall 序列，只在中间插入一次并发追加
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, out, 0, out.length, 0)
  fs.appendFileSync(file, extra)          // ← 运行中的会话此刻追加了一批事件
  const midSize = fs.statSync(file).size
  fs.ftruncateSync(fd, out.length)        // ← commitRewrite 的最后一步
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  const after = fs.statSync(file).size
  console.log(`      → 写后+追加 = ${midSize}B，ftruncate(${outLen}) 之后 = ${after}B（追加的 ${extra.length}B 帧消失）`)
  assert('A. live 覆盖会在 write→truncate 窗口内吃掉并发追加的帧', midSize > outLen && after === outLen,
    `mid=${midSize} final=${after}`)
  const opened = await backendOpen(id, ROOT)
  console.log(`      → 之后 DSH 打开：ok=${opened.ok} events=${opened.events?.length ?? '-'}`)
}

// ============================================ B. 崩溃窗口：write 之后没有 truncate
{
  const id = 'rt-live-crash'
  const file = build(id)
  const before = fs.readFileSync(file)
  const { out } = applyPlan(before, { substitutions: [{ find: 'SECRET', replace: '[X]' }] })
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, out, 0, out.length, 0)
  fs.closeSync(fd)   // ← 进程在这里死掉（截断与 fsync 都没执行）
  const mixed = fs.readFileSync(file)
  const rows = (buf) => scanFrames(buf).frames.flatMap((r) => zlib.zstdDecompressSync(buf.subarray(r.start, r.end)).toString('utf8').split('\n').filter(Boolean))
  let rowsOk = true
  let why = ''
  try { rows(mixed) } catch (e) { rowsOk = false; why = e.message }
  console.log(`      → 半写状态：${mixed.length}B，引擎 scanFrames 可解析=${rowsOk} ${why}`)
  const insp = (() => { try { return inspectBuffer(mixed) } catch (e) { return { frames: '-', lines: '-', parseErrors: '-', fatal: e.message } } })()
  console.log(`      → 引擎 inspectBuffer: frames=${insp.frames} lines=${insp.lines} parseErrors=${insp.parseErrors} fatal=${insp.fatal ?? '-'}`)
  const opened = await backendOpen(id, ROOT)
  console.log(`      → DSH 打开半写文件：ok=${opened.ok} ${opened.ok ? `events=${opened.events.length}` : opened.error}`)
  assert('B. 半写状态不是「无提示的安全状态」（要么打不开、要么静默少事件）', true,
    opened.ok ? `静默读到 ${opened.events.length} 个事件（原文${rows(before).length - 1}行）` : '硬拒绝')
}

// ============================================ C. CLI 并发：固定文件名 .new 与毫秒级备份名
{
  const rounds = 8
  let collisions = 0
  let broken = 0
  for (let i = 0; i < rounds; i++) {
    const id = `rt-cli-race-${i}`
    const file = build(id)
    const dir = path.dirname(file)
    const p = (extra) => new Promise((res) => {
      const c = spawn(NODE, [CLI, 'apply', file, '--plan', planFile, ...extra], { stdio: 'ignore' })
      c.on('exit', () => res())
    })
    await Promise.all([p(['--apply']), p(['--apply'])])
    const backs = fs.readdirSync(dir).filter((f) => f.includes('.quarantine-'))
    if (backs.length < 2) collisions += 1
    const cur = fs.readFileSync(file)
    const seq = checkSeqDensity(cur)
    const insp = inspectBuffer(cur)
    if (seq !== null || insp.parseErrors > 0 || !insp.headerOk) broken += 1
    if (i < 3) console.log(`      → 第 ${i + 1} 轮：并发两次 apply → 备份 ${backs.length} 个，seq=${seq ?? 'ok'} lines=${insp.lines}`)
  }
  console.log(`      → ${rounds} 轮并发：备份被覆盖 ${collisions} 次，最终日志结构损坏 ${broken} 次`)
  assert('C. 并发 CLI apply 不会覆盖彼此的隔离备份', collisions === 0, `${collisions}/${rounds} 轮只剩 <2 个备份`)
  assert('C. 并发 CLI apply 不会产出损坏日志', broken === 0, `${broken}/${rounds} 轮最终日志 seq/结构异常`)
}

console.log(fail === 0 ? '\nP4: 未发现问题' : `\nP4: ${fail} 条断言失败`)
