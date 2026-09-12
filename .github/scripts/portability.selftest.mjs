#!/usr/bin/env node
/**
 * portability 守卫的自检 —— 证明守卫不是摆设。
 *
 * 一个不会失败的检查比没有检查更糟。这里故意把已修好的
 * `process.env.USERPROFILE` 缺陷注回 preflight.mjs，要求守卫必须报错并
 * 指名该文件；然后恢复原文件，要求守卫必须放行。
 *
 * 全程 try/finally 恢复，任何情况下都不会把仓库留在被破坏的状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const GUARD = path.join(HERE, 'portability.mjs')
const TARGET = path.join(ROOT, 'packages/dsh-plugin-redact/test/preflight.mjs')

const CLEAN = `const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')`
const SABOTAGED = `const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')`

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const runGuard = () => {
  try {
    const out = execFileSync(process.execPath, [GUARD], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

console.log('portability 守卫自检')
const original = fs.readFileSync(TARGET, 'utf8')

if (!original.includes(CLEAN)) {
  console.log(`  FAIL  前置条件：preflight.mjs 里找不到预期的那一行，自检无法进行`)
  process.exit(1)
}

try {
  // ---- 1. 干净树：守卫必须放行 ----
  const clean = runGuard()
  check('干净树上守卫放行（退出码 0）', clean.code === 0, `实际退出码 ${clean.code}`)
  check('干净树输出 OK 字样', /OK/.test(clean.out))

  // ---- 2. 注入缺陷：守卫必须报错并指名文件 ----
  const sabotaged = original.replace(CLEAN, SABOTAGED)
  // 行号按注入后的实际位置算，免得以后加一行 import 就把自检写死成红的。
  const expectedLine = sabotaged.split('\n').findIndex((l) => l.includes(SABOTAGED)) + 1
  fs.writeFileSync(TARGET, sabotaged)
  const bad = runGuard()
  check('注入 USERPROFILE 后守卫报错（退出码 1）', bad.code === 1, `实际退出码 ${bad.code}`)
  check('守卫指名 preflight.mjs', /preflight\.mjs/.test(bad.out))
  check('守卫给出 win-only-env 规则名', /win-only-env/.test(bad.out))
  check(
    `守卫指出正确行号（preflight.mjs:${expectedLine}）`,
    new RegExp(`preflight\\.mjs:${expectedLine}\\b`).test(bad.out),
    bad.out.split('\n').find((l) => /preflight/.test(l)) ?? '',
  )

  // ---- 3. 探针：确认注入确实生效（否则上面的"报错"可能来自别的原因）----
  const injected = fs.readFileSync(TARGET, 'utf8')
  check('注入确实写入了目标文件', injected.includes(SABOTAGED))
} finally {
  fs.writeFileSync(TARGET, original)
}

// ---- 4. 恢复后必须回到放行状态 ----
const restored = fs.readFileSync(TARGET, 'utf8')
check('目标文件已按原样恢复', restored === original)
const after = runGuard()
check('恢复后守卫重新放行', after.code === 0, `实际退出码 ${after.code}`)

console.log(`\n${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
