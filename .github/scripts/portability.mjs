#!/usr/bin/env node
/**
 * 可移植性守卫 —— 拦住「只在 Windows 上能跑」的写法。
 *
 * 起因（真实事故）：test/preflight.mjs 用了 `process.env.USERPROFILE`，
 * 在 ubuntu-latest 上是 undefined，`path.join(undefined, '.dsh')` 直接
 * TypeError: The "path" argument must be of type string —— CI 红，且该文件在
 * npm 的 files 白名单里，任何 Linux/macOS 消费者跑 `npm test` 都会炸。
 *
 * 只扫「会发布 / 会在 CI 执行」的代码；docs/ 下的历史报告允许保留
 * %USERPROFILE% 这类已转义的占位符，不在此列。
 *
 * 用 node .github/scripts/portability.mjs 运行；有发现则退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGES = ['packages/dsh-plugin-redact', 'packages/dsh-plugin-content-policy']
const SCAN_SUBDIRS = ['', 'lib', 'bin', 'test']
const EXTS = new Set(['.js', '.mjs', '.cjs', '.yml', '.yaml'])
const SKIP_DIRS = new Set(['node_modules', 'docs', '.git'])

/** 行首注释行直接跳过，避免注释里的示例路径被当成代码。 */
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|#)/.test(line)

/**
 * 显式豁免标记：行内含它就跳过。
 * 用途只有一个 —— 测试里**故意**写出平台专有字样来断言它被拒绝
 * （例如 path-guard 用 'C:\Windows' 当作越界输入）。
 * 刻意做成显式且可 grep：出现即代表有人做过一次判断，而不是规则悄悄失明。
 */
const ALLOW_MARKER = 'portability-allow'

const RULES = [
  {
    id: 'win-only-env',
    // USERPROFILE/HOMEDRIVE/APPDATA/LOCALAPPDATA 在 Linux/macOS 上不存在。
    // 判据是「这个变量自己有没有回退」，而不是「这一行有没有 ??」——
    // `DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')` 里那个 ?? 救不了它。
    re: /process\.env\.(USERPROFILE|HOMEDRIVE|APPDATA|LOCALAPPDATA)\b/g,
    safe: (line, m) => /^\s*(\?\?|\|\|)/.test(line.slice(m.index + m[0].length)),
    msg: 'Windows 专有环境变量且没有回退，非 Windows 上是 undefined；改用 os.homedir()，或紧跟 ?? 回退',
  },
  {
    id: 'import-meta-pathname',
    // new URL(import.meta.url).pathname 在含空格/中文的路径下会残留 %20。
    re: /import\.meta\.url[\s\S]{0,40}?\.pathname/g,
    msg: 'import.meta.url 配 .pathname 拿到的路径可能含 %20 转义；改用 fileURLToPath()',
  },
  {
    id: 'hardcoded-win-path',
    // 引号紧邻盘符才算：这样 "https://x" 不会被误判。
    re: /(['"`])[A-Za-z]:[\\/]/g,
    msg: '硬编码的 Windows 绝对路径',
  },
  {
    id: 'path-win32',
    re: /\bpath\.win32\b/g,
    msg: 'path.win32 只在 Windows 语义下正确；用 path 让平台自己决定',
  },
]

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (EXTS.has(path.extname(e.name).toLowerCase())) yield p
  }
}

const findings = []
let scanned = 0

for (const pkg of PACKAGES) {
  for (const sub of SCAN_SUBDIRS) {
    const dir = path.join(ROOT, pkg, sub)
    for (const file of walk(dir)) {
      // 顶层只收源码/配置，README 等交给 review。
      if (sub === '' && !/\.(js|mjs|cjs|ya?ml)$/i.test(file)) continue
      const rel = path.relative(ROOT, file).replace(/\\/g, '/')
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      scanned++
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return
        if (line.includes(ALLOW_MARKER)) return
        for (const rule of RULES) {
          const re = rule.re.global ? rule.re : new RegExp(rule.re.source, `${rule.re.flags}g`)
          re.lastIndex = 0
          let m
          while ((m = re.exec(line)) !== null) {
            if (rule.safe && rule.safe(line, m)) continue
            findings.push({ rel, line: i + 1, rule: rule.id, msg: rule.msg, text: line.trim() })
            if (m.index === re.lastIndex) re.lastIndex++ // 防零宽匹配死循环
          }
        }
      })
    }
  }
}

const seen = new Set()
const unique = findings.filter((f) => {
  const k = `${f.rel}:${f.line}:${f.rule}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

console.log(`portability: 扫描 ${scanned} 个文件，${PACKAGES.length} 个包`)
if (unique.length === 0) {
  console.log('OK —— 没有发现 Windows-only 假设')
  process.exit(0)
}

console.log(`\n发现 ${unique.length} 处：\n`)
for (const f of unique) {
  console.log(`  ${f.rel}:${f.line}  [${f.rule}]`)
  console.log(`      ${f.text}`)
  console.log(`      → ${f.msg}\n`)
}
process.exit(1)
