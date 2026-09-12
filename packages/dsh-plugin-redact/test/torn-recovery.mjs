// 验证残帧恢复：构造一个「末帧被截断、但其中含完整记录」的日志，
// 确认 applyPlan 不会把它丢掉，而是恢复出完整行并重新落盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { applyPlan, inspectBuffer, scanFrames, checkSeqDensity } from '../lib/engine.mjs'

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), CHECKSUM)
const header = JSON.stringify({ type: 'session', version: 3, id: 'torn-0001', createdAt: 1, isSeeded: false, delegationDepth: 0 })
const ev = (n, t) => JSON.stringify({ type: 'test/event', seq: n, time: 1000 + n, data: { text: t } })

const f0 = frame(header + '\n')
const body = frame([ev(0, 'a'), ev(1, 'b')].join('\n') + '\n')
// 末帧必须**跨多个 zstd 块**才有可恢复的内容：恢复粒度是块（128 KiB 解码数据），
// 单块小帧被截断后连读取端也救不回来。这里造约 500 KB 的多块帧，再从 ~72% 处截断。
const TAIL_ROWS = 6000
const tailRows = []
for (let i = 0; i < TAIL_ROWS; i++) tailRows.push(ev(2 + i, `row-${i}-` + 'p'.repeat(60)))
const tailText = tailRows.join('\n') + '\n'
const tailFull = frame(tailText)
const cutAt = Math.floor(tailFull.length * 0.72)
const original = Buffer.concat([f0, body, tailFull.subarray(0, cutAt)])
console.log(`夹具：明文 ${tailText.length}B / 帧 ${tailFull.length}B / 截断到 ${cutAt}B`)

let total = 0
let passed = 0
const check = (name, ok, detail = '') => {
  total += 1
  if (ok) passed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const scanned = scanFrames(original)
check('夹具确实是残帧（有 tornStart）', scanned.tornStart !== undefined, `tornStart=${scanned.tornStart}`)

const res = applyPlan(original, {})
const out = res.out
const info = inspectBuffer(out)
check('输出无解码错误', info.fatal === undefined && info.parseErrors === 0, info.fatal ?? `parseErrors=${info.parseErrors}`)
check('输出无残帧', info.tornStart === undefined, `tornStart=${info.tornStart}`)
check('seq 仍密集', checkSeqDensity(out) === null, checkSeqDensity(out) ?? '')
// 注意：out 是**压缩后**的容器，要搜明文必须先逐帧解压。
const plainOf = (buf) => {
  const { frames } = scanFrames(buf)
  return frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')).join('')
}
const outPlain = plainOf(out)
check('★ 恢复了残帧里可解码的完整记录', info.lines > 3 && res.stats.recoveredRows > 0, `行数=${info.lines} recoveredRows=${res.stats.recoveredRows}`)
check('★ 恢复出的行内容真实存在（不是空壳）', outPlain.includes('row-0-') && outPlain.includes('"text":"row-0-'), `recoveredRows=${res.stats.recoveredRows}`)
check('stats 报告了恢复行数', res.stats.recoveredRows >= 1, `recoveredRows=${res.stats.recoveredRows}`)
check('notes 说明了恢复', res.notes.some((n) => n.includes('恢复')), res.notes.join(' | '))
check('恢复的行数不超过原帧行数', res.stats.recoveredRows <= TAIL_ROWS, `${res.stats.recoveredRows} <= ${TAIL_ROWS}`)
check('恢复的行 seq 仍连续', (() => {
  const { frames } = scanFrames(out)
  let i = 0
  let bad = false
  for (const f of frames) {
    const plain = zlib.zstdDecompressSync(out.subarray(f.start, f.end)).toString('utf8')
    for (const l of plain.split('\n').filter(Boolean)) {
      const o = JSON.parse(l)
      if (i > 0 && o.seq !== i - 1) bad = true
      i += 1
    }
  }
  return !bad
})())

// 对照：显式 keepTorn 时保留原始残帧字节（旧行为）
const kept = applyPlan(original, { keepTorn: true })
check('keepTorn 仍原样保留残帧字节', inspectBuffer(kept.out).tornStart !== undefined)

console.log(`\n${passed}/${total} 通过`)
fs.rmSync(path.join(os.tmpdir(), 'nonexistent'), { force: true })
process.exit(passed === total ? 0 : 1)
