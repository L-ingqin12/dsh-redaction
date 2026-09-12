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
  STRIP_MARKER,
  STRIP_REASON_NON_STRING,
  STRIP_REASON_PINNED,
  STRIP_REASON_REQUIRED,
  WEB_SEARCH_STRIP_DEFAULTS,
  compileRules,
  compileStripRules,
  createBudget,
  describeHits,
  describeRefusals,
  detectValue,
  headByCodePoints,
  scrubContentBlocks,
  scrubValue,
  stripValue,
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

/** 编译单条 strip 规则。 */
function oneStrip(raw) {
  const { rules, problems } = compileStripRules([raw])
  assert.deepEqual(problems, [], `strip 规则应能编译：${problems.join('; ')}`)
  assert.equal(rules.length, 1)
  return rules
}

/**
 * shipped `web_search` 输出 schema 的**编译后**形状（`dsh-tool-web/lib/index.js:270-298`
 * 的 `required: true` 由 `defineTool` 编译成对象级 `required` 数组，
 * `dsh-tools/lib/index.js:594-603`；校验在 `:454-455`）。
 */
const WEB_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          publishedAt: { type: 'string' },
        },
        required: ['url'],
      },
    },
    truncated: { type: 'boolean' },
  },
  required: ['sources', 'truncated'],
}

/** 造一个合成的 web_search 风格返回值。 */
function searchValue(extra = {}) {
  return {
    content: '模型生成的答案',
    sources: [
      { url: 'https://example.invalid/a', title: 'A', snippet: '第一段摘要', publishedAt: '2026-01-01' },
      { url: 'https://example.invalid/b', title: 'B' },
    ],
    truncated: false,
    ...extra,
  }
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

// ── strip：编译 ─────────────────────────────────────────────────────────────
test('compileStripRules 接受 {id,path} / {id,tool,path,maxChars}，tool 默认 "*"', () => {
  const { rules, problems } = compileStripRules([
    { id: 'a', path: 'content' },
    { id: 'b', tool: 'web_search', path: 'sources.*.snippet', maxChars: 40 },
  ])
  assert.deepEqual(problems, [])
  assert.equal(rules[0].tool, '*')
  assert.equal(rules[0].maxChars, undefined)
  assert.deepEqual(rules[0].segments, ['content'])
  assert.deepEqual(rules[1].segments, ['sources', '*', 'snippet'])
  assert.equal(rules[1].maxChars, 40)
})

test('compileStripRules 对坏 path / 坏 maxChars / 缺 id / 重复 id 报出问题', () => {
  const cases = [
    { raw: [{ path: 'content' }], needle: '缺少非空字符串 id' },
    { raw: [{ id: 'a' }], needle: 'path 必须是非空字符串' },
    { raw: [{ id: 'a', path: '' }], needle: 'path 必须是非空字符串' },
    { raw: [{ id: 'a', path: 'a..b' }], needle: '空段' },
    { raw: [{ id: 'a', path: '.a' }], needle: '空段' },
    { raw: [{ id: 'a', path: 'a.' }], needle: '空段' },
    { raw: [{ id: 'a', path: 'a.*b' }], needle: '必须是独立的一段' },
    { raw: [{ id: 'a', path: '**' }], needle: '必须是独立的一段' },
    { raw: [{ id: 'a', path: 'x'.repeat(1) + '.' + Array.from({ length: 40 }, () => 'y').join('.') }], needle: '最多 32 段' },
    { raw: [{ id: 'a', path: 'content', maxChars: 0 }], needle: 'maxChars 必须是 >= 1 的整数' },
    { raw: [{ id: 'a', path: 'content', maxChars: 1.5 }], needle: 'maxChars 必须是 >= 1 的整数' },
    { raw: [{ id: 'a', path: 'content', maxChars: '9' }], needle: 'maxChars 必须是 >= 1 的整数' },
    { raw: [{ id: 'a', path: 'content', tool: '' }], needle: 'tool 必须是非空字符串' },
    { raw: [{ id: 'a', path: 'content' }, { id: 'a', path: 'content' }], needle: 'id 重复' },
    { raw: ['nope'], needle: '必须是对象' },
  ]
  for (const { raw, needle } of cases) {
    const { problems } = compileStripRules(raw)
    assert.ok(
      problems.some((problem) => problem.includes(needle)),
      `应报出「${needle}」，实际：${problems.join(' | ')}`,
    )
  }
})

// ── strip：真空操作与同一性 ──────────────────────────────────────────────────
test('stripValue 真空操作（rules: []）按引用返回原值，且不改任何计数', () => {
  const value = searchValue()
  const report = stripValue(value, { rules: [], schema: WEB_SEARCH_SCHEMA, budget: createBudget(1 << 20) })
  assert.equal(report.value, value)
  assert.equal(report.changed, false)
  assert.equal(report.matched, false)
  assert.equal(report.dropped, 0)
  assert.equal(report.refused, 0)
  assert.equal(report.scannedBytes, 0)
})

test('路径不存在（可选字段缺失）⇒ missing 计数、按引用返回、原值不被就地修改', () => {
  const value = searchValue()
  const snapshot = JSON.stringify(value)
  const rules = oneStrip({ id: 'no-such', path: 'sources.*.snippet', tool: 'web_search' })
  // 先把 snippet 都去掉，再跑同一条规则 ⇒ 全部 missing。
  const emptied = JSON.parse(snapshot)
  for (const source of emptied.sources) delete source.snippet
  const report = stripValue(emptied, { rules, schema: WEB_SEARCH_SCHEMA, budget: createBudget(1 << 20) })
  assert.equal(report.value, emptied)
  assert.equal(report.missing, 2)
  assert.equal(report.totalHits, 0)
  assert.equal(report.changed, false)
  assert.equal(JSON.stringify(value), snapshot, '不得就地修改入参')
})

test('未变化的子树保持原引用（写时复制）', () => {
  const kept = { url: 'https://example.invalid/keep', title: 'keep' }
  const value = { sources: [kept], truncated: false }
  const report = stripValue(value, {
    rules: oneStrip({ id: 'drop-title', path: 'sources.*.title' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.notEqual(report.value, value)
  assert.notEqual(report.value.sources, value.sources)
  assert.notEqual(report.value.sources[0], kept)
  assert.equal(report.value.sources[0].url, kept.url)
  assert.equal(kept.title, 'keep', '原对象不被就地修改')
})

// ── strip：丢弃 ─────────────────────────────────────────────────────────────
test('通配路径 sources.*.snippet：逐个源对象丢弃该字段（含缺失者）', () => {
  const value = searchValue()
  const report = stripValue(value, {
    rules: oneStrip({ id: 'drop-snippet', tool: 'web_search', path: 'sources.*.snippet' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.equal(report.changed, true)
  assert.equal(report.dropped, 1)
  assert.equal(report.missing, 1, '第二个源本来就没有 snippet')
  assert.deepEqual(report.hits, [{ id: 'drop-snippet', count: 1 }])
  assert.equal(Object.hasOwn(report.value.sources[0], 'snippet'), false)
  assert.equal(report.value.sources[0].url, 'https://example.invalid/a')
  assert.equal(report.value.sources[0].title, 'A')
  assert.equal(report.value.sources[0].publishedAt, '2026-01-01')
  assert.equal(report.value.truncated, false)
})

test('根字段 content 被整个删除，truncated 不受影响', () => {
  const report = stripValue(searchValue(), {
    rules: oneStrip({ id: 'drop-answer', tool: 'web_search', path: 'content' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.equal(Object.hasOwn(report.value, 'content'), false)
  assert.equal(report.dropped, 1)
  assert.equal(report.value.truncated, false)
})

test('对象形状的目标（非字符串）也能整段丢弃，但 maxChars 对它会拒绝', () => {
  const value = { payload: { deep: ['x'] }, note: 'keep' }
  const dropped = stripValue(value, {
    rules: oneStrip({ id: 'drop-payload', path: 'payload' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(Object.hasOwn(dropped.value, 'payload'), false)
  assert.equal(dropped.value.note, 'keep')

  const refused = stripValue(value, {
    rules: oneStrip({ id: 'cut-payload', path: 'payload', maxChars: 8 }),
    budget: createBudget(1 << 20),
  })
  assert.equal(refused.value, value, '拒绝时不得改动任何东西')
  assert.equal(refused.refused, 1)
  assert.deepEqual(refused.refusals, [
    { id: 'cut-payload', tool: '*', path: 'payload', reason: STRIP_REASON_NON_STRING, count: 1 },
  ])
})

test('终止段 "*" 清空数组；"*" 作用在非数组上只是 missing', () => {
  const report = stripValue(searchValue(), {
    rules: oneStrip({ id: 'nuke-sources', path: 'sources.*' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.deepEqual(report.value.sources, [])
  assert.equal(report.dropped, 2)
  assert.deepEqual(report.hits, [{ id: 'nuke-sources', count: 2 }])
  assert.equal(report.value.truncated, false)

  const nonArray = stripValue({ sources: 'oops' }, {
    rules: oneStrip({ id: 'nuke', path: 'sources.*' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(nonArray.value.sources, 'oops')
  assert.equal(nonArray.missing, 1)
})

// ── strip：maxChars ─────────────────────────────────────────────────────────
test('maxChars：超长只留头部 + 省略标记；未超长时一字不动', () => {
  const value = { snippet: 'ABCDEFGHIJ', short: 'OK' }
  const report = stripValue(value, {
    rules: [oneStrip({ id: 'cut', path: 'snippet', maxChars: 4 })[0], oneStrip({ id: 'cut2', path: 'short', maxChars: 4 })[0]],
    budget: createBudget(1 << 20),
  })
  assert.equal(report.value.snippet, `ABCD${STRIP_MARKER}`)
  assert.equal(report.value.short, 'OK')
  assert.equal(report.truncatedFields, 1)
  assert.equal(report.kept, 1)
  assert.equal(report.hits.length, 1)
})

test('maxChars 按 Unicode 码位切，绝不切断代理对', () => {
  assert.equal(headByCodePoints('😀😀😀', 2), '😀😀')
  assert.equal(headByCodePoints('abc', 10), 'abc')
  assert.equal(headByCodePoints('', 3), '')
  const report = stripValue({ emoji: '😀😀😀' }, {
    rules: oneStrip({ id: 'cut', path: 'emoji', maxChars: 2 }),
    budget: createBudget(1 << 20),
  })
  assert.equal(report.value.emoji, `😀😀${STRIP_MARKER}`)
  assert.equal([...report.value.emoji].length, 2 + [...STRIP_MARKER].length)
})

// ── strip：required / enum 的合法性与拒绝 ───────────────────────────────────
test('无 maxChars 且目标是 required 字段 ⇒ 拒绝（required-field），值保持不变', () => {
  const value = searchValue()
  const report = stripValue(value, {
    rules: oneStrip({ id: 'drop-truncated', tool: 'web_search', path: 'truncated' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.equal(report.value, value)
  assert.equal(report.refused, 1)
  assert.equal(report.dropped, 0)
  assert.deepEqual(report.refusals, [
    { id: 'drop-truncated', tool: 'web_search', path: 'truncated', reason: STRIP_REASON_REQUIRED, count: 1 },
  ])

  const urlRefused = stripValue(value, {
    rules: oneStrip({ id: 'drop-url', path: 'sources.*.url' }),
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  assert.equal(urlRefused.refused, 2, '两个源对象的 url 都被拒绝')
  assert.equal(urlRefused.refusals[0].reason, STRIP_REASON_REQUIRED)
  assert.equal(urlRefused.value.sources[0].url, 'https://example.invalid/a')
})

test('required 的字符串字段可以 maxChars 截断：字段仍在、仍是字符串（子集里没有 minLength）', () => {
  const value = { url: 'https://example.invalid/' + 'x'.repeat(50) }
  const schema = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  const report = stripValue(value, {
    rules: oneStrip({ id: 'cut-url', path: 'url', maxChars: 10 }),
    schema,
    budget: createBudget(1 << 20),
  })
  assert.equal(report.refused, 0)
  assert.equal(report.value.url, `https://ex${STRIP_MARKER}`)
  assert.equal(typeof report.value.url, 'string')
})

test('enum/const 固定的值：maxChars 拒绝（截断必然违约），但整字段丢弃允许（enum 约束的是值不是存在）', () => {
  const schema = {
    type: 'object',
    properties: { level: { type: 'string', enum: ['low', 'high'] }, note: { type: 'string' } },
  }
  const value = { level: 'low', note: 'hello world' }

  const truncated = stripValue(value, {
    rules: oneStrip({ id: 'cut-level', path: 'level', maxChars: 2 }),
    schema,
    budget: createBudget(1 << 20),
  })
  assert.equal(truncated.value, value)
  assert.equal(truncated.refusals[0].reason, STRIP_REASON_PINNED)

  const dropped = stripValue(value, {
    rules: oneStrip({ id: 'drop-level', path: 'level' }),
    schema,
    budget: createBudget(1 << 20),
  })
  assert.equal(Object.hasOwn(dropped.value, 'level'), false)
  assert.equal(dropped.refused, 0)
  assert.equal(dropped.value.note, 'hello world')
})

test('没有 schema 时不做 required 判断（permissive：违约由注册表 :3418 兜底报错）', () => {
  const report = stripValue({ anything: 'x' }, {
    rules: oneStrip({ id: 'drop', path: 'anything' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(Object.hasOwn(report.value, 'anything'), false)
  assert.equal(report.refused, 0)
})

test('required 判断会跟进 oneOf 分支（web_fetch 的 body.content 形状）', () => {
  const schema = {
    type: 'object',
    properties: {
      body: {
        oneOf: [
          { type: 'object', properties: { kind: { type: 'string', const: 'html' }, content: { type: 'string' } }, required: ['kind', 'content'] },
          { type: 'object', properties: { kind: { type: 'string', const: 'text' }, content: { type: 'string' } }, required: ['kind', 'content'] },
        ],
      },
    },
  }
  const value = { body: { kind: 'text', content: 'x'.repeat(100) } }
  const refused = stripValue(value, {
    rules: oneStrip({ id: 'drop-body-content', path: 'body.content' }),
    schema,
    budget: createBudget(1 << 20),
  })
  assert.equal(refused.refused, 1)
  assert.equal(refused.refusals[0].reason, STRIP_REASON_REQUIRED)

  const truncated = stripValue(value, {
    rules: oneStrip({ id: 'cut-body-content', path: 'body.content', maxChars: 5 }),
    schema,
    budget: createBudget(1 << 20),
  })
  assert.equal(truncated.value.body.content, `xxxxx${STRIP_MARKER}`)
  assert.equal(truncated.value.body.kind, 'text', '判别字段不受影响')
})

// ── strip：预算 ─────────────────────────────────────────────────────────────
test('预算：整字段丢弃不记账（超长字段照样丢），maxChars 只按保留的原文字节记账', () => {
  const huge = 'x'.repeat(4 * 1024 * 1024)
  const value = { content: huge, snippet: 'y'.repeat(100) }
  const rules = [
    oneStrip({ id: 'drop-content', path: 'content' })[0],
    oneStrip({ id: 'cut-snippet', path: 'snippet', maxChars: 10 })[0],
  ]
  const budget = createBudget(20) // 只够保留 10 字节 + 10 字节
  const report = stripValue(value, { rules, budget })
  assert.equal(Object.hasOwn(report.value, 'content'), false, '丢弃 4 MiB 的字段不消耗预算')
  assert.equal(report.value.snippet, `y`.repeat(10) + STRIP_MARKER)
  assert.equal(report.truncated, false)

  const tight = stripValue({ a: 'z'.repeat(50) }, {
    rules: oneStrip({ id: 'cut-a', path: 'a', maxChars: 10 }),
    budget: createBudget(3),
  })
  assert.equal(tight.value.a, 'z'.repeat(50), '预算不够 ⇒ 保持原样')
  assert.equal(tight.truncated, true)
  assert.equal(tight.skipped, 1)
})

// ── strip：内置的 web_search 规则 ───────────────────────────────────────────
test('WEB_SEARCH_STRIP_DEFAULTS 丢掉 snippet 与 content，保留 url/title/publishedAt/truncated', () => {
  const { rules, problems } = compileStripRules(WEB_SEARCH_STRIP_DEFAULTS)
  assert.deepEqual(problems, [])
  const report = stripValue(searchValue(), {
    rules,
    schema: WEB_SEARCH_SCHEMA,
    budget: createBudget(1 << 20),
  })
  const [first, second] = report.value.sources
  assert.equal(Object.hasOwn(report.value, 'content'), false)
  assert.equal(Object.hasOwn(first, 'snippet'), false)
  assert.equal(Object.hasOwn(second, 'snippet'), false)
  assert.equal(first.url, 'https://example.invalid/a')
  assert.equal(first.title, 'A')
  assert.equal(first.publishedAt, '2026-01-01')
  assert.equal(report.value.truncated, false)
  assert.equal(report.refused, 0, '两条内置规则都不得触碰 required 字段')
  assert.deepEqual(report.hits, [
    { id: 'web-search-snippet', count: 1 },
    { id: 'web-search-answer', count: 1 },
  ])
  assert.equal(report.missing, 1, '第二个源没有 snippet')
})

test('内置规则作用在真实的 web_search 投影上：content 与 presentationMeta 都不再含 snippet/answer', () => {
  // 下面两个投影是 dsh-tool-web/lib/index.js:62-79 与 :103-124 的合成复刻。
  const renderSearch = (value) => {
    const parts = ['External web content follows.']
    if (value.content !== undefined) parts.push(value.content)
    parts.push(`Sources:\n${value.sources.map((s) => `- [${s.title ?? s.url}](${s.url}) — ${s.snippet ?? ''}`).join('\n')}`)
    return [{ type: 'text', text: parts.join('\n\n') }]
  }
  const searchMeta = (value) => ({
    sources: value.sources.map((s) => ({
      url: s.url,
      ...s.title !== undefined ? { title: s.title } : {},
      ...s.snippet !== undefined ? { snippet: s.snippet } : {},
    })),
    truncated: value.truncated,
    ...value.content !== undefined ? { answer: value.content } : {},
  })

  const snippet = '第三方页面里的任意段落-SNIPPET-SYNTHETIC'
  const answer = '模型生成的答案-ANSWER-SYNTHETIC'
  const value = {
    content: answer,
    sources: [{ url: 'https://example.invalid/x', title: 't', snippet }],
    truncated: false,
  }
  const before = JSON.stringify({ content: renderSearch(value), meta: searchMeta(value) })
  assert.ok(before.includes(snippet) && before.includes(answer), '前提：两条通道都带内容')

  const { rules } = compileStripRules(WEB_SEARCH_STRIP_DEFAULTS)
  const report = stripValue(value, { rules, schema: WEB_SEARCH_SCHEMA, budget: createBudget(1 << 20) })
  const after = JSON.stringify({ content: renderSearch(report.value), meta: searchMeta(report.value) })
  assert.ok(!after.includes(snippet), '渲染与 meta 都不应再有 snippet')
  assert.ok(!after.includes(answer), '渲染与 meta 都不应再有 content 答案')
  assert.ok(after.includes('https://example.invalid/x'), 'url 必须保留（它是 required）')
  assert.ok(after.includes('"truncated":false'))
})

// ── strip：多规则顺序 ───────────────────────────────────────────────────────
test('规则依次作用：后一条看到的是前一条的结果', () => {
  const value = { snippet: 'x'.repeat(100) }
  const rules = [
    oneStrip({ id: 'cut', path: 'snippet', maxChars: 20 })[0],
    oneStrip({ id: 'drop', path: 'snippet' })[0],
  ]
  const report = stripValue(value, { rules, budget: createBudget(1 << 20) })
  assert.equal(Object.hasOwn(report.value, 'snippet'), false)
  assert.deepEqual(report.hits, [
    { id: 'cut', count: 1 },
    { id: 'drop', count: 1 },
  ])
})

// ── strip：不可安全遍历 ─────────────────────────────────────────────────────
test('值里的 undefined 目标算"字段不存在"（missing），非无损 JSON 的中间节点算 unsafe', () => {
  const report = stripValue({ bad: undefined, ok: 'x' }, {
    rules: [oneStrip({ id: 'drop-bad', path: 'bad' })[0], oneStrip({ id: 'drop-ok', path: 'ok' })[0]],
    budget: createBudget(1 << 20),
  })
  assert.equal(report.missing, 1, 'undefined 视为字段不存在')
  assert.equal(report.unsafe, 0)
  assert.equal(Object.hasOwn(report.value, 'ok'), false)

  const unsafe = stripValue({ mid: Symbol('not-json'), other: 'keep' }, {
    rules: oneStrip({ id: 'drop-deep', path: 'mid.leaf' }),
    budget: createBudget(1 << 20),
  })
  assert.equal(unsafe.unsafe, 1)
  assert.equal(unsafe.skipped, 1)
  assert.equal(unsafe.changed, false)
  assert.equal(Object.hasOwn(unsafe.value, 'mid'), true, '不可遍历的子树原样保留')
})

// ── strip：唯一失败摘要 ─────────────────────────────────────────────────────
test('describeRefusals 只输出原因码与计数', () => {
  assert.equal(
    describeRefusals([
      { reason: STRIP_REASON_REQUIRED, count: 1 },
      { reason: STRIP_REASON_PINNED, count: 2 },
      { reason: STRIP_REASON_REQUIRED, count: 3 },
    ]),
    'required-field×4, pinned-value×2',
  )
  assert.equal(describeRefusals([]), '')
})

// ── strip 与正则引擎的组合（顺序：先 strip，后正则） ─────────────────────────
test('先 strip 后正则：被丢弃字段里的命中文本不再被正则看见，保留下来的字段照常改写', () => {
  const marker = 'AKIA-SYNTHETIC-0001'
  const value = {
    content: `答案里的 ${marker}`,
    sources: [{ url: 'https://example.invalid/a', title: `标题里的 ${marker}`, snippet: `摘要里的 ${marker}` }],
    truncated: false,
  }
  const { rules: stripRules } = compileStripRules(WEB_SEARCH_STRIP_DEFAULTS)
  const budget = createBudget(1 << 20)
  const stripped = stripValue(value, { rules: stripRules, schema: WEB_SEARCH_SCHEMA, budget })
  const scrubbed = scrubValue(stripped.value, {
    rules: oneRule({ id: 'aws', match: marker, replacement: '<redacted>' }),
    schema: WEB_SEARCH_SCHEMA,
    budget,
  })
  assert.equal(Object.hasOwn(scrubbed.value, 'content'), false)
  assert.equal(Object.hasOwn(scrubbed.value.sources[0], 'snippet'), false)
  assert.equal(scrubbed.value.sources[0].title, '标题里的 <redacted>')
  assert.deepEqual(scrubbed.hits, [{ id: 'aws', count: 1 }], '只剩保留下来的那一处')
  assert.ok(!JSON.stringify(scrubbed.value).includes(marker))
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
