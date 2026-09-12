/**
 * dsh-plugin-content-policy / test/selftest.mjs
 *
 * `lib/scrub.mjs` 的纯逻辑自测：**只用合成数据**（不含任何真实会话内容、不读任何文件），
 * 任何断言失败都会以非零退出码结束。
 *
 * 运行：node test/selftest.mjs
 */

import assert from 'node:assert/strict'
import {
  ACTION_BLOCK,
  ACTION_REPLACE,
  DEFAULT_REPLACEMENT,
  compileRules,
  createBudget,
  describeHits,
  detectValue,
  scrubContentBlocks,
  scrubValue,
  utf8Bytes,
} from '../lib/scrub.mjs'

let passed = 0
const failures = []

/** 跑一个用例；抛异常即失败。 */
function test(title, body) {
  try {
    body()
    passed += 1
    process.stdout.write(`  ✓ ${title}\n`)
  } catch (error) {
    failures.push({ title, error })
    process.stdout.write(`  ✗ ${title}\n      ${error && error.message}\n`)
  }
}

/** 编译单条规则（测试里最常用的快捷方式）。 */
function oneRule(raw) {
  const { rules, problems } = compileRules([raw])
  assert.deepEqual(problems, [], `规则应能编译：${problems.join('; ')}`)
  assert.equal(rules.length, 1)
  return rules
}

process.stdout.write('lib/scrub.mjs 纯逻辑自测\n')

// ── utf8Bytes ────────────────────────────────────────────────────────────────
test('utf8Bytes 按 UTF-8 计字节（ASCII / 中日韩 / emoji）', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('中'), 3)
  assert.equal(utf8Bytes('あ'), 3)
  assert.equal(utf8Bytes('😀'), 4)
  assert.equal(utf8Bytes('a中😀'), 1 + 3 + 4)
  assert.equal(utf8Bytes(''), 0)
})

// ── compileRules ─────────────────────────────────────────────────────────────
test('compileRules 接受字面量、{literal}、{regex,flags} 三种写法', () => {
  const { rules, problems } = compileRules([
    { id: 'a', match: 'secret' },
    { id: 'b', match: { literal: 'SECRET' } },
    { id: 'c', match: { regex: 'se+cret', flags: 'i' } },
  ])
  assert.deepEqual(problems, [])
  assert.deepEqual(rules.map((rule) => rule.kind), ['literal', 'literal', 'regex'])
  assert.equal(rules[0].replacement, DEFAULT_REPLACEMENT)
  assert.equal(rules[0].action, ACTION_REPLACE)
  assert.deepEqual(rules[0].tools, [])
})

test('compileRules 自动补齐全局标志 g（replaceAll 语义要求）', () => {
  const rules = oneRule({ id: 'r', match: { regex: 'x' } })
  assert.equal(rules[0].regex.global, true)
  const rules2 = oneRule({ id: 'r', match: { regex: 'x', flags: 'im' } })
  assert.equal(rules2[0].regex.global, true)
  assert.equal(rules2[0].regex.ignoreCase, true)
})

test('compileRules 缺 id / 空字面量 / 二义 match / 坏正则 / 重复 id 都会报问题', () => {
  const cases = [
    { raw: [{ match: 'x' }], needle: '缺少非空字符串 id' },
    { raw: [{ id: 'a', match: '' }], needle: '空字符串' },
    { raw: [{ id: 'a', match: { literal: 'x', regex: 'y' } }], needle: '只能给出 literal 或 regex 之一' },
    { raw: [{ id: 'a', match: { regex: '(' } }], needle: '正则无法编译' },
    { raw: [{ id: 'a', match: 'x' }, { id: 'a', match: 'y' }], needle: 'id 重复' },
    { raw: [{ id: 'a', match: 'x', action: 'drop' }], needle: 'action 只能是' },
    { raw: [{ id: 'a', match: 'x', tools: 'web_search' }], needle: 'tools 必须是字符串数组' },
  ]
  for (const { raw, needle } of cases) {
    const { problems } = compileRules(raw)
    assert.ok(
      problems.some((problem) => problem.includes(needle)),
      `应报出「${needle}」，实际：${problems.join(' | ')}`,
    )
  }
})

// ── scrubValue：形状与同一性 ─────────────────────────────────────────────────
test('scrubValue 只改字符串叶子，对象/数组形状与其它类型原样保留', () => {
  const value = {
    answer: 'token=AKIA-SYNTHETIC-0001 出现一次',
    sources: [
      { url: 'https://example.invalid/a', title: 'ok', snippet: 'AKIA-SYNTHETIC-0001' },
      { url: 'https://example.invalid/b', title: 'clean' },
    ],
    truncated: false,
    count: 2,
    nothing: null,
  }
  const rules = oneRule({ id: 'aws', match: 'AKIA-SYNTHETIC-0001', replacement: '<redacted>' })
  const report = scrubValue(value, { rules, budget: createBudget(1 << 20) })
  assert.equal(report.matched, true)
  assert.equal(report.changed, true)
  assert.equal(report.totalHits, 2)
  assert.deepEqual(report.hits, [{ id: 'aws', count: 2 }])
  assert.equal(report.value.answer, 'token=<redacted> 出现一次')
  assert.equal(report.value.sources[0].snippet, '<redacted>')
  assert.equal(report.value.sources[1].title, 'clean')
  assert.equal(report.value.truncated, false)
  assert.equal(report.value.count, 2)
  assert.equal(report.value.nothing, null)
  assert.ok(Array.isArray(report.value.sources))
  // 原值未被就地修改（值对象在实际运行中是深冻结的）
  assert.equal(value.sources[0].snippet, 'AKIA-SYNTHETIC-0001')
})

test('scrubValue 无命中时按引用返回原值（注册表同一性快路径）', () => {
  const value = { a: 'nothing to see', b: [1, 2, { c: 'here' }] }
  const rules = oneRule({ id: 'x', match: 'NOT-PRESENT' })
  const report = scrubValue(value, { rules, budget: createBudget(1024) })
  assert.equal(report.value, value)
  assert.equal(report.matched, false)
  assert.equal(report.changed, false)
})

test('未变化的子树保持原引用（写时复制）', () => {
  const shared = { keep: 'unchanged' }
  const value = { hit: 'SECRET', other: shared }
  const rules = oneRule({ id: 's', match: 'SECRET' })
  const report = scrubValue(value, { rules, budget: createBudget(1024) })
  assert.equal(report.value.other, shared)
  assert.notEqual(report.value, value)
})

// ── 替换文本按字面量插入（$& 不得把命中文本写回去） ──────────────────────────
test('replacement 里的 $& / $1 按字面量插入，不会回流命中文本', () => {
  const rules = oneRule({ id: 's', match: { regex: 'SECRET-\\d+' }, replacement: '[$&]' })
  const report = scrubValue({ text: 'x SECRET-42 y' }, { rules, budget: createBudget(1024) })
  assert.equal(report.value.text, 'x [$&] y')
  assert.ok(!report.value.text.includes('SECRET-42'))
})

test('字母量替换同样不做模式展开', () => {
  const rules = oneRule({ id: 's', match: 'SECRET', replacement: '$&$1' })
  const report = scrubValue({ text: 'SECRET' }, { rules, budget: createBudget(1024) })
  assert.equal(report.value.text, '$&$1')
})

// ── schema 感知：enum / const 固定的叶子不改写 ───────────────────────────────
test('被 enum 固定的字符串叶子跳过并计入 pinned（改写必然违约）', () => {
  const schema = {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['SECRET-LEVEL', 'low'] },
      note: { type: 'string' },
    },
  }
  const value = { level: 'SECRET-LEVEL', note: 'SECRET-LEVEL' }
  const rules = oneRule({ id: 's', match: 'SECRET-LEVEL' })
  const report = scrubValue(value, { rules, schema, budget: createBudget(1024) })
  assert.equal(report.value.level, 'SECRET-LEVEL', 'enum 固定值必须原样保留')
  assert.equal(report.value.note, DEFAULT_REPLACEMENT)
  assert.equal(report.pinned, 1)
  assert.deepEqual(report.hits, [{ id: 's', count: 1 }])
})

test('const 固定、以及 oneOf 分支里的 enum 同样被识别为固定', () => {
  const schema = {
    type: 'object',
    properties: {
      fixed: { type: 'string', const: 'TOKEN' },
      branch: { oneOf: [{ type: 'string', enum: ['TOKEN'] }, { type: 'number' }] },
    },
  }
  const report = scrubValue({ fixed: 'TOKEN', branch: 'TOKEN' }, {
    rules: oneRule({ id: 's', match: 'TOKEN' }),
    schema,
    budget: createBudget(1024),
  })
  assert.equal(report.value.fixed, 'TOKEN')
  assert.equal(report.value.branch, 'TOKEN')
  assert.equal(report.pinned, 2)
  assert.equal(report.totalHits, 0)
})

test('数组 items / additionalProperties / oneOf 里的 schema 都会被跟踪', () => {
  const schema = {
    type: 'object',
    properties: {
      list: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string', enum: ['TOKEN'] } } } },
    },
    additionalProperties: { type: 'string', enum: ['TOKEN'] },
  }
  const report = scrubValue({ list: [{ tag: 'TOKEN' }], extra: 'TOKEN' }, {
    rules: oneRule({ id: 's', match: 'TOKEN' }),
    schema,
    budget: createBudget(1024),
  })
  assert.equal(report.pinned, 2)
  assert.equal(report.totalHits, 0)
})

test('没有 schema（undefined）时按不受约束处理', () => {
  const report = scrubValue({ a: 'TOKEN' }, {
    rules: oneRule({ id: 's', match: 'TOKEN' }),
    budget: createBudget(1024),
  })
  assert.equal(report.value.a, DEFAULT_REPLACEMENT)
  assert.equal(report.pinned, 0)
})

// ── 预算 ─────────────────────────────────────────────────────────────────────
test('预算用尽后停止扫描：先前叶子已改写，后续叶子保持原样并标记 truncated', () => {
  const value = { a: 'SECRET', b: 'SECRET' }
  const rules = oneRule({ id: 's', match: 'SECRET' })
  const budget = createBudget(6) // 只够扫第一个叶子（6 字节）
  const report = scrubValue(value, { rules, budget })
  assert.equal(report.value.a, DEFAULT_REPLACEMENT)
  assert.equal(report.value.b, 'SECRET', '预算用尽后不再扫描')
  assert.equal(report.truncated, true)
  assert.equal(report.skipped, 1)
  assert.equal(report.scannedBytes, 6)
})

test('Infinity 预算不受限制', () => {
  const rules = oneRule({ id: 's', match: 'SECRET' })
  const report = scrubValue({ a: 'SECRET', b: 'SECRET' }, { rules, budget: createBudget(Infinity) })
  assert.equal(report.truncated, false)
  assert.equal(report.totalHits, 2)
})

// ── 不可安全遍历 ─────────────────────────────────────────────────────────────
test('深度超限的子树记为 unsafe 并原样保留', () => {
  let deep = 'SECRET'
  for (let index = 0; index < 300; index += 1) deep = { nest: deep }
  const report = scrubValue(deep, {
    rules: oneRule({ id: 's', match: 'SECRET' }),
    budget: createBudget(1 << 20),
  })
  assert.ok(report.unsafe > 0)
  assert.equal(report.totalHits, 0)
})

test('非无损 JSON 节点（undefined）记为 unsafe', () => {
  const report = scrubValue({ ok: 'SECRET', bad: undefined }, {
    rules: oneRule({ id: 's', match: 'SECRET' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(report.value.ok, DEFAULT_REPLACEMENT)
  assert.equal(report.unsafe, 1)
})

// ── 内容块 ───────────────────────────────────────────────────────────────────
test('scrubContentBlocks 只动 text/reasoning 的文本与嵌套 tool-result', () => {
  const blocks = [
    { type: 'text', text: 'Error: SECRET in text' },
    { type: 'image', data: 'SECRET-base64', mimeType: 'image/png' },
    { type: 'reasoning', text: 'SECRET in reasoning' },
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'SECRET nested' }] },
  ]
  const report = scrubContentBlocks(blocks, {
    rules: oneRule({ id: 's', match: 'SECRET' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(report.value[0].text, `Error: ${DEFAULT_REPLACEMENT} in text`)
  assert.equal(report.value[1], blocks[1], '非文本块必须按引用保留')
  assert.equal(report.value[2].text, `${DEFAULT_REPLACEMENT} in reasoning`)
  assert.equal(report.value[3].content[0].text, `${DEFAULT_REPLACEMENT} nested`)
  assert.equal(report.value[3].toolCallId, 'c1')
  assert.equal(blocks[0].text, 'Error: SECRET in text', '原数组不被就地修改')
})

test('scrubContentBlocks 无命中时按引用返回原数组', () => {
  const blocks = [{ type: 'text', text: 'nothing' }]
  const report = scrubContentBlocks(blocks, {
    rules: oneRule({ id: 's', match: 'NOPE' }),
    budget: createBudget(1024),
  })
  assert.equal(report.value, blocks)
})

// ── 探测模式 ─────────────────────────────────────────────────────────────────
test('detectValue 只统计不改写（参数不可改写的接缝）', () => {
  const args = { query: 'AKIA-SYNTHETIC-0001', other: { nested: ['AKIA-SYNTHETIC-0001'] } }
  const snapshot = JSON.stringify(args)
  const report = detectValue(args, {
    rules: [{ id: 'aws', action: ACTION_BLOCK, replacement: 'x', tools: [], kind: 'literal', literal: 'AKIA-SYNTHETIC-0001' }],
    budget: createBudget(1 << 20),
  })
  assert.equal(report.matched, true)
  assert.equal(report.totalHits, 2)
  assert.equal(report.changed, false)
  assert.equal(JSON.stringify(args), snapshot, '探测模式不得改动入参')
})

// ── 复刻 brief 里那个陷阱：同一段文本同时进 content 与 meta ───────────────────
test('改写 value 之后，content 与 presentationMeta 都不再含命中文本', () => {
  // 下面两个投影函数是 dsh-tool-web/lib/index.js:62-79 与 :103-124 的合成复刻：
  // 同一段 snippet 既被渲染进 content，又被 projection 进 presentationMeta。
  const renderSearch = (value) => {
    const parts = ['External web content follows.']
    if (value.content !== undefined) parts.push(value.content)
    parts.push(`Sources:\n${value.sources.map((s) => `- [${s.title ?? s.url}](${s.url}) — ${s.snippet ?? ''}`).join('\n')}`)
    return [{ type: 'text', text: parts.join('\n\n') }]
  }
  const searchMeta = (value) => ({
    sources: value.sources.map((s) => ({ url: s.url, ...(s.snippet !== undefined ? { snippet: s.snippet } : {}) })),
    truncated: value.truncated,
  })

  const secret = 'AKIA-SYNTHETIC-0001'
  const value = {
    content: `answer mentions ${secret}`,
    sources: [{ url: 'https://example.invalid/x', title: 't', snippet: `snippet ${secret}` }],
    truncated: false,
  }
  const before = JSON.stringify({ content: renderSearch(value), meta: searchMeta(value) })
  assert.ok(before.includes(secret), '前提：改写前 content 与 meta 都含命中文本')

  const report = scrubValue(value, {
    rules: oneRule({ id: 'aws', match: secret }),
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' } } } },
        truncated: { type: 'boolean' },
      },
    },
    budget: createBudget(1 << 20),
  })
  const after = JSON.stringify({ content: renderSearch(report.value), meta: searchMeta(report.value) })
  assert.ok(!after.includes(secret), '改写 value 后 content 与 meta 都不应再出现命中文本')
  assert.ok(after.includes(DEFAULT_REPLACEMENT))
  assert.equal(report.totalHits, 2)
})

// ── describeHits ────────────────────────────────────────────────────────────
test('describeHits 只输出规则 id 与计数', () => {
  assert.equal(describeHits([{ id: 'a', count: 2 }, { id: 'b', count: 1 }]), 'a×2, b×1')
  assert.equal(describeHits([]), '')
})

// ── 结果 ────────────────────────────────────────────────────────────────────
process.stdout.write(`\n${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const failure of failures) {
    process.stdout.write(`- ${failure.title}\n  ${failure.error && failure.error.stack}\n`)
  }
  process.exit(1)
}
process.exit(0)
