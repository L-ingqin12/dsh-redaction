/**
 * dsh-plugin-content-policy / test/registry-e2e.mjs
 *
 * **对着真正的 `@deepseek-ai/dsh-tools` 注册表跑一遍**（不是假 ctx）：用真的
 * cordis `Context` + 真的 `SystemPrompt` + 真的 `ToolRuntime` 装配本插件
 * （`ToolRuntime` 的 static inject 是 `systemPrompt`，所以两者都要挂），注册一个
 * 合成工具，然后调用 `ctx.tools.execute()`，断言：
 *
 *   1. 成功结果：插件改写 value ⇒ 注册表用 value **重新派生** content 与 meta
 *      （dsh-tools/lib/index.js:3458 → :3415），两处都不再出现命中文本 —— 这正是
 *      "只换 content 不够" 那条结论的实测。
 *   2. 失败结果：插件重建 `{ isError, error, content }` ⇒ content / error.message
 *      被改写、meta 不存在。
 *   3. 真空操作：未配置规则时流水线原样通过。
 *   4. block 规则：真注册表在 pre-execute 就拒绝，工具体不被调用。
 *
 * 需要 DSH 安装目录里的 node_modules（默认取本机路径，可用环境变量覆盖）：
 *   DSH_NODE_MODULES=<...>\@deepseek-ai\dsh\node_modules node test/registry-e2e.mjs
 *
 * 目录不存在时以 0 退出并说明「跳过」，避免在没装 DSH 的机器上误报。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_INSTALL = '%USERPROFILE%\\nodejs-x64\\node-v22.21.0-win-x64\\node_modules\\@deepseek-ai\\dsh\\node_modules'
const installRoot = process.env.DSH_NODE_MODULES ?? DEFAULT_INSTALL
const SECRET = 'AKIA-SYNTHETIC-0001'

if (!fs.existsSync(path.join(installRoot, '@deepseek-ai', 'dsh-tools'))) {
  process.stdout.write(`跳过：找不到 ${installRoot}\\@deepseek-ai\\dsh-tools（用 DSH_NODE_MODULES 指定）\n`)
  process.exit(0)
}

const load = (specifier) => import(pathToFileURL(path.join(installRoot, specifier)).href)
const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const ToolRuntime = (await load('@deepseek-ai/dsh-tools/lib/index.js')).default
const SystemPrompt = (await load('@deepseek-ai/dsh-system-prompt/lib/index.js')).default
const plugin = await import('../index.js')

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

/**
 * 装配一个真注册表 + 本插件。
 * `ctx.get('tools')` 是 cordis 的「无 inject 声明读取」入口，等价于测试里的取用点。
 */
async function mount(config, tool) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  if (config !== undefined) await root.plugin(plugin, config)
  const tools = root.get('tools')
  assert.ok(tools !== undefined, 'tools 服务应已装配')
  if (tool !== undefined) tools.register(tool)
  return { root, tools }
}

/** 合成工具：值里带命中文本，render 与 presentationMeta 都会把它投影出去。 */
function syntheticTool() {
  return {
    name: 'synth_search',
    description: '合成工具：复刻 web_search 的 content + presentationMeta 双通道',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [value.content, ...(value.sources ?? []).map((source) => `- ${source.url} — ${source.snippet ?? ''}`)].join('\n'),
        },
      ],
      presentationMeta: (_args, value) => ({ sources: value.sources ?? [], answer: value.content }),
    },
    async execute() {
      return {
        content: `answer mentions ${SECRET}`,
        sources: [{ url: 'https://example.invalid/x', snippet: `snippet ${SECRET}` }],
      }
    },
  }
}

/** 合成失败工具：抛错，错误信息里带命中文本。 */
function failingTool() {
  return {
    name: 'synth_fail',
    description: '合成工具：抛错，错误信息里带命中文本',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'ok' }],
      presentationMeta: () => ({ snippet: SECRET }),
    },
    async execute() {
      throw new Error(`boom ${SECRET}`)
    },
  }
}

const SIGNAL = () => new AbortController().signal
const RULES = [{ id: 'aws', match: SECRET, replacement: '<redacted>', action: 'replace', tools: [] }]

process.stdout.write(`对真注册表的端到端验证（install=${installRoot}）\n`)

await test('真空操作：未配置规则 ⇒ 注册表原样返回（content/meta 都不动）', async () => {
  const { tools } = await mount(undefined, syntheticTool())
  const result = await tools.execute({ callId: 'c0', name: 'synth_search', arguments: {}, signal: SIGNAL() })
  assert.equal(result.isError, false)
  assert.ok(result.content[0].text.includes(SECRET))
  assert.ok(JSON.stringify(result.meta).includes(SECRET))
})

await test('成功结果：改写 value ⇒ content 与 meta 都由改写后的 value 重新派生', async () => {
  const { tools } = await mount({ enabled: true, rules: RULES, notify: true }, syntheticTool())
  const result = await tools.execute({ callId: 'c1', name: 'synth_search', arguments: {}, signal: SIGNAL() })

  assert.equal(result.isError, false)
  assert.ok(!result.content[0].text.includes(SECRET), `content 不应再含命中文本：${result.content[0].text}`)
  assert.ok(!JSON.stringify(result.meta ?? '').includes(SECRET), `meta 不应再含命中文本：${JSON.stringify(result.meta)}`)
  assert.ok(result.content[0].text.includes('<redacted>'))
  assert.ok(JSON.stringify(result.meta).includes('<redacted>'))
  assert.ok(!JSON.stringify(result.value).includes(SECRET), '规范化后的 value 也应是改写后的')
  assert.equal(result.additionalContexts.length, 1)
  assert.equal(result.additionalContexts[0].source.plugin, 'content-policy')
  assert.ok(!JSON.stringify(result.additionalContexts).includes(SECRET), '通知里不得含命中文本')
})

await test('失败结果：插件重建的结果被注册表接受，content/error.message 被改写且无 meta', async () => {
  const { tools } = await mount({ enabled: true, rules: RULES, notify: true }, failingTool())
  const result = await tools.execute({ callId: 'c2', name: 'synth_fail', arguments: {}, signal: SIGNAL() })

  assert.equal(result.isError, true)
  assert.equal(result.meta, undefined, '失败结果不应带 meta')
  assert.ok(!JSON.stringify(result.content).includes(SECRET), `失败 content 不应再含命中文本：${JSON.stringify(result.content)}`)
  assert.ok(!String(result.error?.message ?? '').includes(SECRET), 'error.message 也应被改写')
  assert.equal(result.content[0].type, 'text')
})

await test('block 规则：真注册表在 pre-execute 拒绝执行，工具体不会被调用', async () => {
  let invoked = false
  const tool = syntheticTool()
  tool.execute = async () => {
    invoked = true
    return { content: 'should not run', sources: [] }
  }
  const { tools } = await mount(
    { enabled: true, rules: [{ id: 'nope', match: SECRET, action: 'block', replacement: '[已移除]', tools: [] }] },
    tool,
  )
  const result = await tools.execute({
    callId: 'c3',
    name: 'synth_search',
    arguments: { query: `q ${SECRET}` },
    signal: SIGNAL(),
  })
  assert.equal(invoked, false, '工具体不得被调用')
  assert.equal(result.isError, true)
  assert.ok(!JSON.stringify(result.content).includes(SECRET), '拒绝理由里不得含命中文本')
  assert.ok(result.content[0].text.includes('nope'))
})

await test('rules[].tools 过滤：未列入的工具结果完全不受影响', async () => {
  const { tools } = await mount(
    { enabled: true, rules: [{ id: 'aws', match: SECRET, action: 'replace', replacement: '<redacted>', tools: ['other_tool'] }] },
    syntheticTool(),
  )
  const result = await tools.execute({ callId: 'c4', name: 'synth_search', arguments: {}, signal: SIGNAL() })
  assert.ok(result.content[0].text.includes(SECRET), '未列入 tools 的工具不应被改写')
})

await test('enum 固定的输出：改写会被放弃（不产出必然违约的 value）', async () => {
  const tool = {
    name: 'synth_enum',
    description: '合成工具：输出 schema 用 enum 固定字符串',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { level: { type: 'string', enum: [SECRET] } } },
      render: (_args, value) => [{ type: 'text', text: value.level }],
    },
    async execute() {
      return { level: SECRET }
    },
  }
  const { tools } = await mount({ enabled: true, rules: RULES }, tool)
  const result = await tools.execute({ callId: 'c5', name: 'synth_enum', arguments: {}, signal: SIGNAL() })
  assert.equal(result.isError, false, '不得因为 enum 固定就把调用打成错误')
  assert.equal(result.value.level, SECRET, '注册表校验仍然通过（值保持合法）')
})

process.stdout.write(`\n${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const failure of failures) {
    process.stdout.write(`- ${failure.title}\n  ${failure.error && failure.error.stack}\n`)
  }
  process.exit(1)
}
process.exit(0)
