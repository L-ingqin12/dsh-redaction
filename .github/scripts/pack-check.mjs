#!/usr/bin/env node
/**
 * 发布内容校验 —— 「别人装到的东西」是不是完整的、干净的。
 *
 * 起因：两个包的 npm `files` 白名单是手工维护的（index.js 引 lib/engine.mjs，
 * bin 又引一遍）。只要有人加了一个 import 却忘了把文件写进 files，
 * 本地怎么跑都是绿的，消费者装完却缺文件 —— 一个 CI 看不见的失败模式。
 *
 * 这里不装包、不联网，只做两件事：
 *   1. npm pack --dry-run 列出真正会进 tarball 的文件；
 *   2. 顺着包内每个相对 import 走一遍，确认目标文件都在 tarball 里。
 * 顺带挡住测试残留（fixture/plan/needle/broken 之类）混进发布物。
 *
 * 用 node .github/scripts/pack-check.mjs 运行；有发现则退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGES = ['packages/dsh-plugin-redact', 'packages/dsh-plugin-content-policy']

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

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** 从源码里抓出所有以 ./ 或 ../ 开头的 import 说明符。 */
const RELATIVE_IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g

function relativeImports(file) {
  const src = fs.readFileSync(file, 'utf8')
  const out = new Set()
  let m
  RELATIVE_IMPORT_RE.lastIndex = 0
  while ((m = RELATIVE_IMPORT_RE.exec(src)) !== null) out.add(m[1])
  return [...out]
}

/** 相对说明符 -> 包内路径：按「导入方所在目录」解析，bin/../lib/x 要落到 lib/x。 */
function resolveInPackage(importerRel, spec) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec))
}

for (const pkg of PACKAGES) {
  const dir = path.join(ROOT, pkg)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  console.log(`\n=== ${manifest.name}@${manifest.version} ===`)

  let packed
  try {
    const raw = execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 npm 是 .cmd，Node 22 不允许直接 execFile 一个 .cmd（EINVAL）。
      shell: process.platform === 'win32',
    })
    packed = JSON.parse(raw)[0]
  } catch (e) {
    check('npm pack --dry-run 可执行', false, String(e.stderr ?? e.message).trim().split('\n')[0])
    continue
  }

  const shipped = new Set(packed.files.map((f) => f.path))
  console.log(`  会发布 ${packed.entryCount} 个文件，${(packed.size / 1024).toFixed(1)} KB（解包 ${(packed.unpackedSize / 1024).toFixed(1)} KB）`)

  // 1. files 白名单里的每一项都必须真的在包里
  const missing = (manifest.files ?? []).filter((f) => !shipped.has(f))
  check('files 白名单全部命中实际内容', missing.length === 0, `白名单里有但包里没有：${missing.join(', ')}`)

  // 2. npm 自动带的元文件
  for (const f of ['package.json', 'README.md', 'LICENSE']) {
    check(`包含 ${f}`, shipped.has(f))
  }

  // 3. 测试残留不许混进去
  const junk = [...shipped].filter((p) =>
    /\.tgz$|\.log$|^node_modules\/|\.new$|(^|\/)fixture\.|(^|\/)needle\.txt$|(^|\/)broken\.zstd$|(^|\/)plan-.*\.json$/.test(p),
  )
  check('没有测试残留混入', junk.length === 0, junk.join(', '))

  // 4. 最关键的一条：包内相对 import 的目标文件必须也在包里
  //    只扫会真正被加载的入口（index.js / bin / lib），test/ 里的 import 由各自的套件负责。
  const entryFiles = [...shipped].filter((p) => /^(index\.js|bin\/.*\.mjs|lib\/.*\.mjs)$/.test(p))
  const dangling = []
  for (const rel of entryFiles) {
    for (const spec of relativeImports(path.join(dir, rel))) {
      const target = resolveInPackage(rel, spec)
      // 说明符可能省扩展名，按 Node 的解析顺序试一遍。
      const candidates = [target, `${target}.mjs`, `${target}.js`, `${target}/index.mjs`]
      if (!candidates.some((c) => shipped.has(c))) dangling.push(`${rel} → ${spec}`)
    }
  }
  check('包内相对 import 的目标都在 tarball 里', dangling.length === 0, dangling.join('; '))

  // 5. 入口自己得在包里
  const main = (manifest.main ?? 'index.js').replace(/^\.\//, '')
  check(`main (${main}) 在包里`, shipped.has(main))

  // 6. 社区市场共用的 manifest 闸门：dsh.bundle.patch 指向的文件必须在包里，
  //    且必须是**顶层 YAML 数组**、含一条 name 等于包名的 loader entry。
  //    这一条决定市场给不给 manifest_verified（可一键安装）还是只列出可浏览。
  const patchRel = manifest.dsh?.bundle?.patch?.replace(/^\.\//, '')
  if (patchRel === undefined) {
    check('声明了 dsh.bundle.patch', false, 'package.json 里没有 dsh.bundle.patch')
  } else {
    check(`声明了 dsh.bundle.patch（${patchRel}）`, true)
    check('patch 文件在 tarball 里', shipped.has(patchRel), patchRel)
    const patchPath = path.join(dir, patchRel)
    const text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
    const firstCode = text.split(/\r?\n/).find((l) => l.trim() !== '' && !/^\s*#/.test(l))
    check(
      'patch 是顶层 YAML 数组（首个有效行以 - 开头）',
      firstCode !== undefined && /^\s*-\s/.test(firstCode),
      `实际首个有效行：${firstCode ?? '(文件为空)'}`,
    )
    const nameRe = new RegExp(`name:\\s*${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
    check('patch 里有 name 等于包名的 loader entry', nameRe.test(text))
  }
}

// ── 仓库级：catalogue 是顺着根 package.json 的 `dsh.bundles` 找到子目录包的 ──
// 依据：plugin.dshdesk.com 的 scripts/sync-plugins.mjs 先读 HEAD:package.json，
// 再由 assets/bundle-manifest.js 的 listBundleDirectories() 取出 dsh.bundles 数组，
// 逐个读 HEAD:<dir>/package.json。根目录没有 package.json 时该数组为空 ——
// monorepo 里的包对扫描器等于不存在（topic 加了也扫不到）。
console.log('\n=== 仓库根（catalogue 的发现入口）===')
const rootPkgPath = path.join(ROOT, 'package.json')
if (!fs.existsSync(rootPkgPath)) {
  check('根 package.json 存在', false, '没有它，catalogue 发现不了 monorepo 子目录里的包')
} else {
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
  const dirs = rootPkg.dsh?.bundles
  check('根 package.json 存在', true)
  check('根声明了 dsh.bundles 数组', Array.isArray(dirs) && dirs.length > 0, `实际：${JSON.stringify(dirs)}`)

  const listed = new Set()
  for (const d of Array.isArray(dirs) ? dirs : []) {
    check(`  dsh.bundles 条目以 ./ 开头（${d}）`, typeof d === 'string' && d.startsWith('./'))
    if (typeof d !== 'string') continue
    const norm = d.replace(/^\.\//, '').replace(/\/+$/, '')
    listed.add(norm)
    const subPkgPath = path.join(ROOT, norm, 'package.json')
    if (!fs.existsSync(subPkgPath)) {
      check(`  ${norm} 下有 package.json`, false)
      continue
    }
    const sub = JSON.parse(fs.readFileSync(subPkgPath, 'utf8'))
    const patch = sub.dsh?.bundle?.patch
    check(
      `  ${norm} 的 dsh.bundle.patch 合规（./ 开头）`,
      typeof patch === 'string' && patch.startsWith('./'),
      `实际：${JSON.stringify(patch)}`,
    )
  }

  // 新增了包却忘了登记，收录会静默漏掉 —— 这里拦住。
  for (const pkg of PACKAGES) {
    check(`  ${pkg} 已登记进 dsh.bundles`, listed.has(pkg))
  }
}

console.log(`\n${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
