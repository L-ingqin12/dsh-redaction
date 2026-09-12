#!/usr/bin/env node
/**
 * selftest — 用合成日志验证 zsplice 引擎。全部是假内容，不涉及任何真实会话。
 *
 * 覆盖：帧扫描、行定位、原地改写、清空、删除的后缀/中间两种判定、
 *       seq 密集性自检、未触碰帧原字节保留、头部保护、损坏文件拒绝。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanFrames, inspectBuffer, checkSeqDensity } from '../lib/engine.mjs'

// fileURLToPath 而不是 .pathname：后者在含空格/中文的路径下会留下 %20 之类的转义。
const DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(DIR, '..', 'bin', 'dsh-redact.mjs')
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)

const log = path.join(DIR, 'fixture.jsonl.zstd')
const header = JSON.stringify({ type: 'session', version: 3, id: 'test-0001', createdAt: 1, isSeeded: false, delegationDepth: 0 })
// seq 是「事件行自 0 起」的编号：第 2 个逻辑行 seq=0
const ev = (n, text) => JSON.stringify({ type: 'test/event', seq: n, time: 1000 + n, data: { text } })

const f0 = frame(header + '\n')
const f1 = frame([ev(0, 'alpha'), ev(1, 'beta SECRET-ONE gamma'), ev(2, 'delta')].join('\n') + '\n')
const f2 = frame([ev(3, 'epsilon SECRET-TWO'), ev(4, 'zeta')].join('\n') + '\n')
const f3 = frame([ev(5, 'eta'), ev(6, 'theta')].join('\n') + '\n')
fs.writeFileSync(log, Buffer.concat([f0, f1, f2, f3]))

const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const fails = (args) => {
  try {
    run(args)
    return false
  } catch {
    return true
  }
}
let total = 0
let passed = 0
const check = (name, ok, detail = '') => {
  total += 1
  if (ok) passed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- 基础结构
const insp = run(['inspect', log, '--frames'])
check('inspect 帧数=4', /完整帧数\s*:\s*4/.test(insp))
check('inspect 行数=8', /逻辑总行数\s*:\s*8/.test(insp))
check('inspect 帧明细 4 条', (insp.match(/^\s*\d+\s+\d+-\d+/gm) ?? []).length === 4)
check('原始文件 seq 密集', checkSeqDensity(fs.readFileSync(log)) === null)

// ---- 命中定位（只给行号，不给文本）
fs.writeFileSync(path.join(DIR, 'needle.txt'), 'SECRET-ONE')
const hit = run(['inspect', log, '--match-file', path.join(DIR, 'needle.txt')])
check('命中行号=3', /命中行号\s*:\s*3\b/.test(hit), hit.match(/命中行号.*/)?.[0])
check('命中输出不含原文', !/SECRET-ONE/.test(hit))

// ---- 结构浏览
const p = run(['paths', log, '--line', '3'])
check('paths 列出 data.text', /data\.text\s*=\s*string/.test(p))
check('paths 不打印值', !/SECRET-ONE/.test(p) && !/beta/.test(p))

// ---- 原地改写（主力路径，结构不变）
const inPlace = {
  substitutions: [{ find: 'SECRET-TWO', replace: '[已移除]' }],
  setFields: [{ line: 6, path: 'data.text', value: '[已移除]' }],
  blankLines: '7',
}
fs.writeFileSync(path.join(DIR, 'plan-inplace.json'), JSON.stringify(inPlace, null, 2))
const outInPlace = run(['apply', log, '--plan', path.join(DIR, 'plan-inplace.json')])
check('原地改写：无删除', /删除 \/ 清空\s*:\s*0 \/ 1/.test(outInPlace), outInPlace.match(/删除 \/ 清空.*/)?.[0])

const b1 = fs.readFileSync(log + '.new')
const s1 = scanFrames(b1)
check('原地改写后仍是 4 帧', s1.frames.length === 4, `实际 ${s1.frames.length}`)
check('原地改写后仍是 8 行', inspectBuffer(b1).lines === 8)
check('原地改写后 seq 仍密集', checkSeqDensity(b1) === null)
check('未触碰帧 0 原字节保留', b1.subarray(s1.frames[0].start, s1.frames[0].end).equals(f0))
check('未触碰帧 1 原字节保留', b1.subarray(s1.frames[1].start, s1.frames[1].end).equals(f1))

const rows1 = s1.frames.flatMap((f) => zlib.zstdDecompressSync(b1.subarray(f.start, f.end)).toString('utf8').split('\n').filter(Boolean))
const at = (n) => JSON.parse(rows1[n - 1])
check('全局替换生效（第 5 行）', !at(5).data.text.includes('SECRET-TWO') && at(5).data.text.includes('[已移除]'), at(5).data.text)
check('路径改写生效（第 6 行）', at(6).data.text === '[已移除]')
check('清空生效（第 7 行）', at(7).data.text === '[已移除]')
check('清空未破坏类型与 seq', at(7).type === 'test/event' && at(7).seq === 5)
check('未指定行未被误改（第 3 行）', at(3).data.text === 'beta SECRET-ONE gamma')
check('原文已不可见', !rows1.join('').includes('SECRET-TWO') && !rows1.join('').includes('"eta"'))

// ---- 中间行删除：默认必须拒绝
check('中间行删除被拒绝（无 renumber）', fails(['cut', log, '--drop', '4']))

// ---- 中间行删除 + renumber：放行且 seq 重新密集
const outCut = run(['cut', log, '--drop', '4', '--renumber'])
check('renumber 删除执行成功', /删除行\s*:\s*1/.test(outCut))
const b2 = fs.readFileSync(log + '.new')
check('renumber 后 7 行', inspectBuffer(b2).lines === 7)
const seqProblem = checkSeqDensity(b2)
check('renumber 后 seq 密集', seqProblem === null, seqProblem ?? '')
const plain2 = scanFrames(b2).frames.map((f) => zlib.zstdDecompressSync(b2.subarray(f.start, f.end)).toString('utf8')).join('')
check('被删除行确已消失', !plain2.includes('delta'))
check('后续行 seq 已重编号', /"seq":2[^0-9]/.test(plain2) && /"seq":5[,}]/.test(plain2))

// ---- 后缀删除：不需要 renumber 就应放行
const outSuffix = run(['cut', log, '--drop', '8'])
check('后缀删除直接放行', /删除行\s*:\s*1/.test(outSuffix))
check('后缀删除后 seq 密集', checkSeqDensity(fs.readFileSync(log + '.new')) === null)

// ---- 保护与拒绝
check('拒绝删除头部行', fails(['cut', log, '--drop', '1']))
check('拒绝清空头部行', fails(['apply', log, '--plan', (() => {
  const f = path.join(DIR, 'plan-head.json')
  fs.writeFileSync(f, JSON.stringify({ blankLines: '1' }))
  return f
})()]))
check('拒绝改写结构键 seq', fails(['apply', log, '--plan', (() => {
  const f = path.join(DIR, 'plan-seq.json')
  fs.writeFileSync(f, JSON.stringify({ setFields: [{ line: 3, path: 'seq', value: 99 }] }))
  return f
})()]))

// ---- 损坏文件必须被拒
fs.writeFileSync(path.join(DIR, 'broken.zstd'), Buffer.concat([f0, Buffer.from('not-a-frame')]))
check('损坏文件被拒绝', fails(['verify', path.join(DIR, 'broken.zstd')]))

// ---- verify 正常退出
let verifyOk = true
try {
  run(['verify', log + '.new'])
} catch {
  verifyOk = false
}
check('verify 正常退出', verifyOk)

// ---- plan 试算不写文件
fs.rmSync(log + '.new', { force: true })
run(['plan', log, '--plan', path.join(DIR, 'plan-inplace.json')])
check('plan 试算不写文件', !fs.existsSync(log + '.new'))

// 清理本套件产生的夹具（否则会被一起提交进包）
for (const f of [
  'fixture.jsonl.zstd', 'fixture.jsonl.zstd.new', 'needle.txt',
  'plan-inplace.json', 'plan-head.json', 'plan-seq.json', 'broken.zstd',
]) {
  fs.rmSync(path.join(DIR, f), { force: true })
}

console.log(`\n${passed}/${total} 通过`)
fs.rmSync(log + '.new', { force: true })
process.exit(passed === total ? 0 : 1)
