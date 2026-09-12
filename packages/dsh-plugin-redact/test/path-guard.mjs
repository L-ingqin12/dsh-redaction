#!/usr/bin/env node
/**
 * 路径闸门测试 —— 会话 id 是本插件唯一由外部输入决定文件路径的地方，
 * 而它会改写日志。这里断言它拼不出会话根之外的路径。
 *
 * 起因：resolveLog 原本直接 path.join(root, project, sessionId)，
 * `--session ../../../x` 会被规范化到 root 之外。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(new URL('../index.js', import.meta.url).href)

let passed = 0
let total = 0
const check = (name, ok, detail = '') => {
  total++
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 搭一个假的会话根：root/proj/<uuid>/session.v3.jsonl.zstd
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-pathguard-'))
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-pathguard-cache-'))
const UUID = '11111111-2222-3333-4444-555555555555'
const sessDir = path.join(root, '--fake-project--', UUID)
fs.mkdirSync(sessDir, { recursive: true })
// 放一个合法的最小日志：首行 header + 一行 seq=0
const zlib = await import('node:zlib')
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), CHECKSUM)
const header = JSON.stringify({ type: 'session', version: 3, id: UUID, createdAt: 1, isSeeded: false, delegationDepth: 0 })
const ev = JSON.stringify({ type: 'test/event', seq: 0, time: 2, data: { text: 'hello' } })
fs.writeFileSync(path.join(sessDir, 'session.v3.jsonl.zstd'), Buffer.concat([frame(header + '\n'), frame(ev + '\n')]))

// root 之外放一个「诱饵」会话目录，结构与真实的一致 —— 越界成功就会命中它
const outside = path.join(path.dirname(root), 'redact-pathguard-outside', '--fake-project--', UUID)
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'session.v3.jsonl.zstd'), Buffer.concat([frame(header + '\n'), frame(ev + '\n')]))

let captured = null
mod.apply({ commands: { register(def) { captured = def } }, get: () => undefined }, {
  root,
  cacheRoot,
  placeholder: '[已移除]',
})

const run = (rawInput) => captured.handler({ rawInput, agent: undefined })

console.log('路径闸门测试')

// ── 1. 合法 id 必须照常工作（加固不能误伤）
const okOut = await run(`verify --session ${UUID}`)
check(
  '合法 UUID 能解析到日志',
  okOut.kind === 'success' && /11111111/.test(okOut.text) && /帧 2/.test(okOut.text),
  JSON.stringify(okOut).slice(0, 160),
)

// ── 2. 越界输入必须被拒，且报错里出现「非法」
const escapes = [
  ['../redact-pathguard-outside', '../../redact-pathguard-outside'],
  ['..', '..'],
  ['.', '.'],
  ['a/../../b', 'a/../../b'],
  ['a\\..\\..\\b', 'a\\..\\..\\b'],
  ['C:\\Windows', 'C:\\Windows'], // portability-allow: 故意的越界输入，断言它被拒绝
  ['/etc', '/etc'],
]
for (const [label, id] of escapes) {
  const out = await run(`verify --session ${id}`)
  const rejected = out.kind === 'error' && /非法/.test(out.text)
  check(`拒绝越界会话 id ${JSON.stringify(label)}`, rejected, `kind=${out.kind} text=${String(out.text).slice(0, 90)}`)
}

// 空 id 走的是「未提供」分支而不是「非法」分支：两者都算拒绝，只要不解析出日志。
{
  const out = await run('verify --session ')
  check(
    '拒绝空会话 id',
    out.kind === 'error' && /非法|无法确定目标会话/.test(out.text),
    `kind=${out.kind} text=${String(out.text).slice(0, 90)}`,
  )
}

// ── 3. 诱饵目录绝不能被读到（真正的越界证据）
const bait = path.join(outside, 'session.v3.jsonl.zstd')
const baitTouched = await run(`verify --session ../../redact-pathguard-outside`)
check('越界尝试没有命中 root 之外的诱饵日志', baitTouched.kind === 'error')
check('诱饵文件未被改动', fs.readFileSync(bait).length > 0)

// ── 4. listSessions 仍然只列 root 内的（列表里显示的是短 id）
const listOut = await run('list')
check(
  'list 只看得到 root 内的会话',
  listOut.kind === 'success' && listOut.text.includes('11111111') && listOut.text.includes('共 1 个会话'),
  String(listOut.text).slice(0, 120),
)

// ── 5. 任意工作目录可用 —— 发布代码里没有 process.cwd()，所有根路径要么来自
//        DSH_HOME，要么是调用方显式给出的文件路径。这里从无关目录实测一遍。
const CLI = path.join(HERE, '..', 'bin', 'dsh-redact.mjs')
const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-cwd-'))
const logAbs = path.join(sessDir, 'session.v3.jsonl.zstd')

{
  // CLI 的 verify 打的是多行报告（`完整帧数       : 2`），
  // 插件命令打的是紧凑摘要（`帧 2 · 行 2`）—— 两者格式不同，别拿一个的正则匹配另一个。
  const out = execFileSync(process.execPath, [CLI, 'verify', logAbs], { cwd: otherCwd, encoding: 'utf8' })
  check('从无关工作目录用绝对路径跑 CLI', /完整帧数\s*:\s*2/.test(out), out.split('\n')[1] ?? out.slice(0, 80))
}
{
  const rel = path.relative(otherCwd, logAbs)
  const out = execFileSync(process.execPath, [CLI, 'verify', rel], { cwd: otherCwd, encoding: 'utf8' })
  check(
    `从无关工作目录用相对路径跑 CLI（${rel.slice(0, 24)}…）`,
    /完整帧数\s*:\s*2/.test(out),
    out.split('\n')[1] ?? out.slice(0, 80),
  )
}
{
  const prev = process.cwd()
  try {
    process.chdir(otherCwd)
    const out = await run(`verify --session ${UUID}`)
    check(
      '插件在无关工作目录下仍解析到 root 内的会话',
      out.kind === 'success' && /11111111/.test(out.text),
      String(out.text).slice(0, 100),
    )
  } finally {
    process.chdir(prev)
  }
}
fs.rmSync(otherCwd, { recursive: true, force: true })

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(cacheRoot, { recursive: true, force: true })
fs.rmSync(path.dirname(outside), { recursive: true, force: true })

console.log(`\n${passed}/${total} 通过`)
process.exit(passed === total ? 0 : 1)
