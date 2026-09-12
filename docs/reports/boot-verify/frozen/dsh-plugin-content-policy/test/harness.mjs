/**
 * dsh-plugin-content-policy / test/harness.mjs
 *
 * `index.js` 的**契约测试**：用一个假 ctx（假的 `on` / `logger` / `tools.get`）
 * 驱动真正的插件代码，断言它在三条接缝上的返回值形状符合 shipped 注册表的语义：
 *
 *   - 成功结果：返回 `{ isError:false, value }`，**不带** content/meta
 *     —— 因为注册表会用 value 重新派生它们（dsh-tools/lib/index.js:3458 → :3415）。
 *   - 失败结果：返回 `{ isError:true, error, content }` 且**不带** meta
 *     —— 因为失败结果的 content/meta 是被逐字复制的（:3449-3455）。
 *   - 参数命中阻断规则：`tools/pre-execute` 返回 `{ kind:'deny', reason }`。
 *
 * 这不是端到端测试：真正的注册表流水线需要宿主进程。这里只验证本插件自己的
 * 输入/输出契约，运行：node test/harness.mjs
 */

import assert from 'node:assert/strict'
import { Config, apply, inject, name } from '../index.js'
import { utf8Bytes } from '../lib/scrub.mjs'

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

/** 造一个假 ctx；`tools` 是 { 工具名: 定义 } 的表。 */
function createCtx(tools = {}) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    logger: {
      debug() {},
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    on(event, callback, options) {
      const list = listeners.get(event) ?? []
      list.push({ callback, options })
      listeners.set(event, list)
    },
    tools: {
      get: (toolName) => tools[toolName],
    },
  }
  return { ctx, listeners, logs }
}

/** 取出某条接缝上注册的第 0 个回调。 */
function seam(listeners, event) {
  const list = listeners.get(event)
  assert.ok(list && list.length > 0, `应注册 ${event} 监听器`)
  return list[0].callback
}

/** 走一遍真实配置校验（等价于 cordis 的 resolveConfig）。 */
function validated(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined, `配置应通过校验：${JSON.stringify(result.issues)}`)
  return result.value
}

const SECRET = 'AKIA-SYNTHETIC-0001'
const RULES = [{ id: 'aws', match: SECRET, replacement: '<redacted>' }]
const WEB_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
    truncated: { type: 'boolean' },
  },
}
const TOOLS = { web_search: { name: 'web_search', output: { schema: WEB_SEARCH_SCHEMA } } }

process.stdout.write('index.js 契约测试（假 ctx）\n')

// ── 导出面 ───────────────────────────────────────────────────────────────────
await test('导出 name / inject / Config / apply', () => {
  assert.equal(name, 'content-policy')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config['~standard'].validate, 'function')
})

await test('Config 是 Standard Schema：补默认值、拒绝错类型', () => {
  const value = validated({})
  assert.equal(value.enabled, true)
  assert.deepEqual(value.rules, [])
  assert.equal(value.onBudgetExceeded, 'partial')
  assert.equal(value.onUnsafeValue, 'keep')
  assert.equal(value.notify, true)
  assert.equal(typeof value.maxScannedBytes, 'number')
  const bad = Config['~standard'].validate({ enabled: 'yes' })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0)
  const badEnum = Config['~standard'].validate({ onBudgetExceeded: 'whatever' })
  assert.ok(Array.isArray(badEnum.issues) && badEnum.issues.length > 0)
  const badRule = Config['~standard'].validate({ rules: [{ match: 'x' }] })
  assert.ok(Array.isArray(badRule.issues) && badRule.issues.length > 0)
})

// ── 真空操作默认 ─────────────────────────────────────────────────────────────
await test('默认（无配置 / 空 rules / enabled:false）不注册任何监听器', () => {
  for (const raw of [undefined, {}, { rules: [] }, { enabled: false, rules: RULES }]) {
    const { ctx, listeners } = createCtx(TOOLS)
    apply(ctx, validated(raw))
    assert.equal(listeners.size, 0, `配置 ${JSON.stringify(raw)} 下不应注册监听器`)
  }
})

// ── 成功结果 ─────────────────────────────────────────────────────────────────
await test('成功结果：改写 value，不返回 content/meta，并附带 plugin 通知', async () => {
  const { ctx, listeners, logs } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const exec = { name: 'web_search', callId: 'c1', agent: undefined, arguments: { queries: ['x'] } }
  const original = {
    isError: false,
    value: {
      content: `answer ${SECRET}`,
      sources: [{ url: 'https://example.invalid/x', title: 't', snippet: `snip ${SECRET}` }],
      truncated: false,
    },
    content: [{ type: 'text', text: `answer ${SECRET}` }],
    meta: { sources: [{ url: 'https://example.invalid/x', snippet: `snip ${SECRET}` }] },
  }
  const out = await seam(listeners, 'tools/execute')(exec, async () => original)

  assert.equal(out.isError, false)
  assert.equal(Object.hasOwn(out, 'content'), false, '不得只换 content：注册表会用 value 重新渲染')
  assert.equal(Object.hasOwn(out, 'meta'), false, 'meta 会被重新派生，不应由插件提供')
  assert.ok(!JSON.stringify(out.value).includes(SECRET))
  assert.equal(out.value.sources[0].snippet, 'snip <redacted>')
  assert.ok(Array.isArray(out.additionalContexts) && out.additionalContexts.length === 1)

  const notice = out.additionalContexts[0]
  assert.equal(notice.role, 'user')
  assert.equal(typeof notice.id, 'string')
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'content-policy')
  assert.equal(notice.content[0].type, 'text')
  assert.ok(!JSON.stringify(notice).includes(SECRET), '通知里绝不能出现命中文本')
  assert.ok(notice.content[0].text.includes('aws×2'))

  assert.ok(logs.some((entry) => entry.message.includes('aws×2')))
  assert.ok(!JSON.stringify(logs).includes(SECRET), '日志里绝不能出现命中文本')
})

await test('成功结果无命中：按引用返回原结果（走注册表同一性快路径）', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const exec = { name: 'web_search', callId: 'c2', arguments: {} }
  const original = { isError: false, value: { content: 'clean', sources: [], truncated: false }, content: [], meta: { a: 1 } }
  const out = await seam(listeners, 'tools/execute')(exec, async () => original)
  assert.equal(out, original)
})

await test('rules[].tools 过滤：不相关的工具完全跳过（不碰 value）', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: [{ id: 'aws', match: SECRET, tools: ['read'] }] }))
  const exec = { name: 'web_search', callId: 'c3', arguments: {} }
  const original = { isError: false, value: { content: SECRET }, content: [], meta: {} }
  const out = await seam(listeners, 'tools/execute')(exec, async () => original)
  assert.equal(out, original)
})

await test('enum 固定的叶子不改写（pinned 计数进日志，不进结果）', async () => {
  const tools = { pick: { name: 'pick', output: { schema: { type: 'object', properties: { level: { type: 'string', enum: [SECRET] } } } } } }
  const { ctx, listeners, logs } = createCtx(tools)
  apply(ctx, validated({ rules: RULES }))
  const original = { isError: false, value: { level: SECRET }, content: [], meta: {} }
  const out = await seam(listeners, 'tools/execute')({ name: 'pick', callId: 'c4', arguments: {} }, async () => original)
  assert.equal(out, original, '全部命中都因 enum 固定而跳过 ⇒ 无改动 ⇒ 原引用返回')
  assert.ok(logs.every((entry) => !entry.message.includes('命中')))
})

// ── 失败结果 ─────────────────────────────────────────────────────────────────
await test('失败结果：重建 { isError, error, content } 且省略 meta', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const exec = { name: 'web_search', callId: 'c5', arguments: {} }
  const original = {
    isError: true,
    error: { message: `boom ${SECRET}`, info: { name: 'SomeError', code: 'SOME_CODE' } },
    content: [{ type: 'text', text: `Error: boom ${SECRET}` }],
    meta: { snippet: SECRET },
  }
  const out = await seam(listeners, 'tools/execute')(exec, async () => original)
  assert.equal(out.isError, true)
  assert.equal(Object.hasOwn(out, 'meta'), false, '失败结果一经重建就必须丢弃 meta')
  assert.ok(!JSON.stringify(out).includes(SECRET))
  assert.equal(out.error.info.code, 'SOME_CODE', 'error.info 必须保留（replay/路由要用）')
  assert.equal(out.content[0].text, 'Error: boom <redacted>')
  assert.ok(out.additionalContexts[0].content[0].text.includes('aws'))
})

await test('失败结果无命中且无 meta：按引用返回', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const original = { isError: true, error: { message: 'nope' }, content: [{ type: 'text', text: 'Error: nope' }] }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c6', arguments: {} }, async () => original)
  assert.equal(out, original)
})

// ── 预算与降级 ───────────────────────────────────────────────────────────────
await test('onBudgetExceeded=error：预算不足时整条结果降级为终态错误', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES, maxScannedBytes: 4, onBudgetExceeded: 'error' }))
  const original = {
    isError: false,
    value: { content: `${SECRET}${SECRET}`, sources: [], truncated: false },
    content: [],
    meta: {},
  }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c7', arguments: {} }, async () => original)
  assert.equal(out.isError, true)
  assert.equal(out.error.info.code, 'CONTENT_POLICY')
  assert.equal(Object.hasOwn(out, 'value'), false)
  assert.ok(!JSON.stringify(out).includes(SECRET))
})

await test('onBudgetExceeded=partial（默认）：截断处停止，已扫描部分照常改写', async () => {
  const { ctx, listeners, logs } = createCtx(TOOLS)
  // 预算刚好够第一个叶子，第二个叶子触发截断。
  apply(ctx, validated({ rules: RULES, maxScannedBytes: utf8Bytes(SECRET) }))
  const original = {
    isError: false,
    value: { a: SECRET, b: SECRET },
    content: [],
    meta: {},
  }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c8', arguments: {} }, async () => original)
  assert.equal(out.value.a, '<redacted>')
  assert.equal(out.value.b, SECRET)
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('预算')))
})

await test('onUnsafeValue=error：出现不可遍历节点时降级为终态错误', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES, onUnsafeValue: 'error' }))
  const original = { isError: false, value: { ok: SECRET, bad: undefined }, content: [], meta: {} }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c9', arguments: {} }, async () => original)
  assert.equal(out.isError, true)
  assert.equal(out.error.info.code, 'CONTENT_POLICY')
})

await test('策略自身抛错时绝不破坏工具调用（保留原结果 + 告警）', async () => {
  const { ctx, listeners, logs } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const hostile = { visible: SECRET }
  Object.defineProperty(hostile, 'boom', {
    enumerable: true,
    get() {
      throw new Error('synthetic getter failure')
    },
  })
  const original = { isError: false, value: hostile, content: [], meta: {} }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c10', arguments: {} }, async () => original)
  assert.equal(out, original)
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('保留原结果')))
})

// ── 阻断接缝 ─────────────────────────────────────────────────────────────────
await test('block 规则：pre-execute 返回 deny，理由里不含命中文本', async () => {
  const { ctx, listeners, logs } = createCtx(TOOLS)
  apply(ctx, validated({ rules: [{ id: 'nope', match: { literal: SECRET }, action: 'block', replacement: '[已移除]', tools: [] }] }))
  assert.ok(listeners.has('tools/pre-execute'), '有 block 规则时必须注册 pre-execute')
  assert.ok(!listeners.has('tools/execute'), '只有 block 规则时不需要主接缝')
  const exec = { name: 'web_search', callId: 'c11', arguments: { queries: [`q ${SECRET}`] } }
  const decision = await seam(listeners, 'tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.ok(!decision.reason.includes(SECRET))
  assert.ok(decision.reason.includes('nope×1'))
  assert.ok(!JSON.stringify(logs).includes(SECRET))
})

await test('block 规则未命中：正常放行（next() 委托）', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: [{ id: 'nope', match: SECRET, action: 'block', replacement: '[已移除]', tools: ['read'] }] }))
  const decision = await seam(listeners, 'tools/pre-execute')({ name: 'web_search', callId: 'c12', arguments: { q: SECRET } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

// ── ptc 派发日志接缝 ─────────────────────────────────────────────────────────
await test('ptc-dispatch-log：只改日志副本的 content', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const content = [{ type: 'text', text: `sub result ${SECRET}` }]
  const out = await seam(listeners, 'tools/ptc-dispatch-log')(
    { name: 'web_search', subCallId: 'c1:ptc:1', isError: false, content, exec: { name: 'run_code' } },
    async () => content,
  )
  assert.equal(out[0].text, 'sub result <redacted>')
  assert.equal(content[0].text, `sub result ${SECRET}`, '原数组不被就地修改')
})

await test('ptc-dispatch-log：无命中时按引用返回', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const content = [{ type: 'text', text: 'clean' }]
  const out = await seam(listeners, 'tools/ptc-dispatch-log')({ name: 'web_search', content, isError: false }, async () => content)
  assert.equal(out, content)
})

// ── notify 开关 ──────────────────────────────────────────────────────────────
await test('notify:false 时不追加 additionalContexts，但仍写日志', async () => {
  const { ctx, listeners, logs } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES, notify: false }))
  const original = { isError: false, value: { content: SECRET, sources: [], truncated: false }, content: [], meta: {} }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c13', arguments: {} }, async () => original)
  assert.equal(Object.hasOwn(out, 'additionalContexts'), false)
  assert.ok(logs.some((entry) => entry.message.includes('aws×1')))
})

await test('已有的 additionalContexts 会被保留并追加通知', async () => {
  const { ctx, listeners } = createCtx(TOOLS)
  apply(ctx, validated({ rules: RULES }))
  const prior = { id: 'prior', role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'prior' }] }
  const original = { isError: false, value: { content: SECRET }, content: [], meta: {}, additionalContexts: [prior] }
  const out = await seam(listeners, 'tools/execute')({ name: 'web_search', callId: 'c14', arguments: {} }, async () => original)
  assert.equal(out.additionalContexts.length, 2)
  assert.equal(out.additionalContexts[0], prior)
})

// ── 配置错误必须 fail loud ───────────────────────────────────────────────────
await test('非法规则让插件拒绝装配（fail loud 而非静默放行）', () => {
  const { ctx } = createCtx(TOOLS)
  assert.throws(
    () => apply(ctx, { enabled: true, rules: [{ id: 'x', match: '' }] }),
    /已拒绝装配/,
  )
  assert.throws(
    () => apply(ctx, { enabled: true, rules: RULES, maxScannedBytes: 0 }),
    /maxScannedBytes/,
  )
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
