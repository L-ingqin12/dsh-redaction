/**
 * dsh-plugin-content-policy / test/config-schemastery.mjs
 *
 * `index.js` 的 Config 是**双轨**的：能解析到 `@deepseek-ai/schemastery` 时导出真正的
 * Schemastery schema（`buildSchemasteryConfig`），否则退回内置的 Standard Schema 实现
 * （`buildFallbackConfig`）。另外两个测试文件跑的都是**兜底轨道**（插件目录解析不到
 * `@deepseek-ai/*`，这正是 `link:` 安装方式的现实），所以 Schemastery 轨道需要单独验证 ——
 * 否则 `strip` / `StripRule` 那部分 schema 代码就成了没人跑的分支。
 *
 * 做法：在系统临时目录里造一个探针包（copy 本包的 index.js + lib/，再用 junction 把
 * 安装目录里的 `@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 链进它的 node_modules），
 * 然后 import 探针的 index.js。跑完删掉探针目录。
 *
 * 需要 DSH 安装目录里的 @deepseek-ai 包（默认取本机路径，可用 DSH_NODE_MODULES 覆盖）；
 * 找不到时以 0 退出并说明「跳过」。
 *
 * 运行：node test/config-schemastery.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_INSTALL = path.join(
  process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '.',
  'profiles',
  'node_modules',
)
const installRoot = process.env.DSH_NODE_MODULES ?? DEFAULT_INSTALL
const packageRoot = path.resolve(import.meta.dirname, '..')
const probeRoot = path.join(os.tmpdir(), `dsh-content-policy-schemastery-${process.pid}`)

if (!fs.existsSync(path.join(installRoot, '@deepseek-ai', 'schemastery'))) {
  // 不能 exit 0：那会让「本轮根本没跑」看起来像通过（陌生人 npm test 静默变绿）。
  console.error(`跳过：找不到 ${installRoot}\\@deepseek-ai\\schemastery（用 DSH_NODE_MODULES 指向含 @deepseek-ai 的 node_modules）`)
  process.exit(3)
}

let passed = 0
const failures = []

async function test(title, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ✓ ${title}\n`)
  } catch (error) {
    failures.push({ title, error })
    process.stdout.write(`  ✗ ${title}\n      ${error && error.message}\n`)
  }
}

process.stdout.write(`Schemastery 轨道的 Config 校验（install=${installRoot}）\n`)

try {
  // ── 造探针包 ───────────────────────────────────────────────────────────────
  fs.rmSync(probeRoot, { recursive: true, force: true })
  fs.mkdirSync(path.join(probeRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
  fs.cpSync(path.join(packageRoot, 'index.js'), path.join(probeRoot, 'index.js'))
  fs.cpSync(path.join(packageRoot, 'lib'), path.join(probeRoot, 'lib'), { recursive: true })
  fs.writeFileSync(
    path.join(probeRoot, 'package.json'),
    JSON.stringify({ name: 'dsh-content-policy-schemastery-probe', type: 'module', version: '0.0.0' }),
  )
  for (const dependency of ['schemastery', 'cordis']) {
    fs.symlinkSync(
      path.join(installRoot, '@deepseek-ai', dependency),
      path.join(probeRoot, 'node_modules', '@deepseek-ai', dependency),
      'junction',
    )
  }

  const probe = await import(pathToFileURL(path.join(probeRoot, 'index.js')).href)
  const validate = (raw) => probe.Config['~standard'].validate(raw)

  await test('Schemastery 轨道：默认值完整（含 strip / stripDefaults / onStripRefused）', () => {
    const result = validate({})
    assert.equal(result.issues, undefined, JSON.stringify(result.issues))
    assert.deepEqual(result.value.rules, [])
    assert.deepEqual(result.value.strip, [])
    assert.equal(result.value.stripDefaults, false)
    assert.equal(result.value.onStripRefused, 'error')
    assert.equal(result.value.onBudgetExceeded, 'partial')
    assert.equal(result.value.notify, true)
  })

  await test('Schemastery 轨道：strip 规则补 tool="*"，maxChars 原样保留', () => {
    const result = validate({
      strip: [
        { id: 'a', path: 'sources.*.snippet' },
        { id: 'b', tool: 'web_search', path: 'content', maxChars: 200 },
      ],
      stripDefaults: true,
      onStripRefused: 'skip',
      rules: [{ id: 'r', match: { regex: 'x' } }],
    })
    assert.equal(result.issues, undefined, JSON.stringify(result.issues))
    assert.deepEqual(result.value.strip, [
      { id: 'a', tool: '*', path: 'sources.*.snippet' },
      { id: 'b', tool: 'web_search', path: 'content', maxChars: 200 },
    ])
    assert.equal(result.value.stripDefaults, true)
    assert.equal(result.value.onStripRefused, 'skip')
  })

  await test('Schemastery 轨道：0 / 小数 / 负数 / 非数字 在配置校验阶段就被拒，Infinity 保留', () => {
    const pathOf = (issue) => (Array.isArray(issue.path) ? issue.path.join('.') : '')

    for (const value of [0, 1.5, -1, '1024', NaN, -Infinity]) {
      const result = validate({ maxScannedBytes: value })
      assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `maxScannedBytes=${String(value)} 应被拒：${JSON.stringify(result)}`)
      assert.ok(result.issues.some((issue) => pathOf(issue).includes('maxScannedBytes')), `issue 应带字段路径：${JSON.stringify(result.issues)}`)
      assert.ok(result.issues.every((issue) => typeof issue.message === 'string' && issue.message.length > 0), 'issue 必须有可读文案')
    }
    assert.equal(validate({ maxScannedBytes: Infinity }).value.maxScannedBytes, Infinity, '`.inf`（不限预算）语义必须保留')
    assert.equal(validate({ maxScannedBytes: 1 }).value.maxScannedBytes, 1)
    assert.equal(validate({ maxScannedBytes: 4096 }).value.maxScannedBytes, 4096)

    for (const value of [0, 1.5, -1, '200', Infinity, NaN]) {
      const result = validate({ strip: [{ id: 'a', path: 'content', maxChars: value }] })
      assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `maxChars=${String(value)} 应被拒：${JSON.stringify(result)}`)
      assert.ok(result.issues.some((issue) => pathOf(issue).includes('maxChars')), `issue 应带 maxChars 路径：${JSON.stringify(result.issues)}`)
    }
    assert.equal(validate({ strip: [{ id: 'a', path: 'content', maxChars: 1 }] }).value.strip[0].maxChars, 1)
    assert.equal(validate({ strip: [{ id: 'a', path: 'content' }] }).value.strip[0].maxChars, undefined, '不写 maxChars 仍然合法')
  })

  await test('Schemastery 轨道：坏 strip 配置产生 issues 而不是抛错', () => {
    for (const raw of [
      { strip: [{ id: 'a' }] },
      { strip: [{ path: 'content' }] },
      { strip: 'content' },
      { stripDefaults: 'yes' },
      { onStripRefused: 'nope' },
    ]) {
      const result = validate(raw)
      assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `应报问题：${JSON.stringify(raw)}`)
    }
  })

  await test('Schemastery 轨道：校验后的配置能真正装配（strip 挂在主接缝上）', () => {
    const schema = {
      type: 'object',
      required: ['sources', 'truncated'],
      properties: {
        content: { type: 'string' },
        sources: {
          type: 'array',
          items: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, snippet: { type: 'string' } } },
        },
        truncated: { type: 'boolean' },
      },
    }
    const listeners = new Map()
    const logs = []
    const ctx = {
      logger: { debug() {}, info: (message) => logs.push(message), warn: (message) => logs.push(message), error() {} },
      on(event, callback) {
        listeners.set(event, [...(listeners.get(event) ?? []), callback])
      },
      tools: { get: () => ({ name: 'web_search', output: { schema } }) },
    }
    const config = validate({ strip: [{ id: 'drop-snippet', tool: 'web_search', path: 'sources.*.snippet' }] })
    assert.equal(config.issues, undefined)
    probe.apply(ctx, config.value)
    assert.ok(listeners.has('tools/execute'), '应注册 tools/execute')
    assert.equal(listeners.has('tools/pre-execute'), false)
    assert.equal(listeners.has('tools/ptc-dispatch-log'), false)
  })
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true })
}

process.stdout.write(`\n${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const failure of failures) {
    process.stdout.write(`- ${failure.title}\n  ${failure.error && failure.error.stack}\n`)
  }
  process.exit(1)
}
process.exit(0)
