/**
 * P6 — 规模：内存与二次方开销。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const { applyPlan, checkSeqDensity, inspectBuffer, loadLog, scanFrames } = await import(pathToFileURL('%USERPROFILE%/dsh-plugin-redact/lib/engine.mjs').href)

const DIR = path.join(os.tmpdir(), 'rt-redact', 'scale')
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })

const ZOPTS = { params: [undefined, undefined] }
ZOPTS.params = { [zlib.constants.ZSTD_c_checksumFlag]: 1 }
const frame = (t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), ZOPTS)

const rnd = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)

/** rows of `rowBytes` bytes each, `perFrame` rows per frame */
function buildLog(file, rows, rowBytes, perFrame) {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'scale', createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
  const chunks = [frame(header)]
  let buf = []
  for (let i = 0; i < rows; i++) {
    buf.push(JSON.stringify({ type: 'tool/result', seq: i, time: 1000 + i, data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: rnd(rowBytes) }] }] } } }) + '\n')
    if (buf.length === perFrame) { chunks.push(frame(buf.join(''))); buf = [] }
  }
  if (buf.length) chunks.push(frame(buf.join('')))
  fs.writeFileSync(file, Buffer.concat(chunks))
  return fs.statSync(file).size
}

const mb = (n) => (n / 1048576).toFixed(1) + 'MB'
const rss = () => process.memoryUsage().rss

console.log('== A. ~50MB 日志：时间与内存 ==')
{
  const file = path.join(DIR, 'big.zstd')
  const size = buildLog(file, 26000, 2000, 25)
  const base = rss()
  console.log(`      文件 ${mb(size)}，26000 行，${scanFrames(fs.readFileSync(file)).frames.length} 帧`)

  let t = Date.now(); const log = loadLog(file); const tLoad = Date.now() - t
  const afterLoad = rss()
  console.log(`      loadLog        : ${tLoad}ms  RSS +${mb(afterLoad - base)}`)
  const plainBytes = log.frameViews.reduce((a, v) => a + v.plain.length, 0)
  console.log(`      解压后明文   : ${mb(plainBytes)}（loadLog 把每一帧的明文全留在内存里）`)

  t = Date.now()
  const rowsParsed = []
  for (const v of log.frameViews) for (const l of v.lines) rowsParsed.push(JSON.parse(v.plain.subarray(l.start, l.end).toString('utf8')))
  const tRows = Date.now() - t
  const afterRows = rss()
  console.log(`      逐行 JSON.parse（readRows/planRollback 的做法）: ${tRows}ms  RSS +${mb(afterRows - afterLoad)}  共 ${rowsParsed.length} 行`)

  const buf = fs.readFileSync(file)
  t = Date.now()
  const res = applyPlan(buf, { substitutions: [{ find: 'zzzzzz', replace: '[X]' }] })  // 全局替换 → 每帧都要重建
  const tApply = Date.now() - t
  console.log(`      applyPlan（所有帧重写）: ${tApply}ms  输出 ${mb(res.out.length)}`)

  t = Date.now(); const seq = checkSeqDensity(res.out); const tSeq = Date.now() - t
  console.log(`      checkSeqDensity: ${tSeq}ms（${seq ?? '通过'}）— applyPlan 内部已跑过一次 inspectBuffer+checkSeqDensity`)

  t = Date.now(); inspectBuffer(res.out); console.log(`      inspectBuffer  : ${Date.now() - t}ms`)
  console.log(`      峰值 RSS: ${mb(rss())}（原始文件 ${mb(size)}）`)
}

console.log('\n== B. 二次方项：帧数 × 行数 ==')
{
  const rows = 24000, rowBytes = 100
  for (const perFrame of [2400, 240, 24]) {
    const file = path.join(DIR, `quad-${perFrame}.zstd`)
    const size = buildLog(file, rows, rowBytes, perFrame)
    const frames = scanFrames(fs.readFileSync(file)).frames.length
    const buf = fs.readFileSync(file)
    const t = Date.now()
    applyPlan(buf, { substitutions: [{ find: 'zzzzzz', replace: '[X]' }] })
    console.log(`      帧数 ${String(frames).padStart(5)}（每帧 ${String(perFrame).padStart(4)} 行，${mb(size)}）→ applyPlan ${String(Date.now() - t).padStart(6)}ms`)
  }
  console.log('      （行数固定，只有帧数变化；applyPlan:406 每帧都 map+filter 全部行 → O(帧数×行数)）')
}

console.log('\n== C. Math.min(...dropIdx) 展开上限（renumber） ==')
{
  const file = path.join(DIR, 'min.zstd')
  buildLog(file, 300000, 40, 3000)
  const buf = fs.readFileSync(file)
  const t = Date.now()
  try {
    applyPlan(buf, { dropLines: '2-200000', renumber: true })
    console.log(`      30 万行 renumber 删除：${Date.now() - t}ms（未抛 RangeError）`)
  } catch (e) {
    console.log(`      30 万行 renumber 删除：${Date.now() - t}ms → ${e.constructor.name}: ${e.message}`)
  }
  fs.rmSync(file, { force: true })
}
