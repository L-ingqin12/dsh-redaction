/**
 * dsh-plugin-content-policy / lib/scrub.mjs
 *
 * 纯函数清洗引擎：**不 import 任何 Cordis / DSH / Node 内置模块**，因此
 * `test/selftest.mjs` 可以直接用合成的工具返回值调用它。
 *
 * 设计原则
 * --------
 * 1. 规则驱动、内容无关：引擎只负责「定位 + 改写」，匹配什么由用户给的规则决定。
 * 2. 绝不因为清洗而破坏对象形状：只改写**字符串叶子**，数组仍是数组、对象仍是对象、
 *    数字/布尔/null 原样保留 —— 这样注册表重新校验 `output.schema` 时仍然合法。
 * 3. 保守优先：被 `enum` / `const` 固定的字符串叶子一律不改写（改写必然违约），
 *    记为 `pinned` 并上报；不可遍历的节点记为 `unsafe`，由上层决定是否降级。
 * 4. 绝不返回/打印命中的文本：只返回规则 id 与计数。
 * 5. 两条互补的策略：**正则引擎**（内容相关，改写字面量/正则命中）与
 *    **结构最小化引擎**（内容无关，按字段路径整段丢弃或截断）。后者用于
 *    "事先无法枚举"的文本：不判断它是什么，只让它**根本不进来**。
 *
 * 术语
 * ----
 * - **改写 (rewrite)**：把命中片段替换为 `replacement`。
 * - **探测 (detect)**：只统计命中，不做任何改动（用于"阻断参数"那一条接缝）。
 * - **预算 (budget)**：本次调用允许扫描（正则）或保留（strip）的 UTF-8 字节总数；
 *   用尽后停止扫描。
 * - **丢弃 (drop)**：把某个字段/数组元素从值里**整个删掉**（`strip` 的默认动作）。
 * - **截断 (truncate)**：只保留字段的头 `maxChars` 个字符 + 省略标记。
 * - **拒绝 (refuse)**：规则会产出违反 `output.schema` 的值，因此**不执行**并上报
 *   （由上层决定降级或放行）—— 绝不静默产出非法值。
 */

/** 默认替换文本（与 dsh-plugin-redact 保持一致）。 */
export const DEFAULT_REPLACEMENT = '[已移除]'

/** 动作：改写命中内容。 */
export const ACTION_REPLACE = 'replace'
/** 动作：命中即拒绝执行（只在 pre-execute / guard 接缝上有意义）。 */
export const ACTION_BLOCK = 'block'

/** 递归深度上限；超过即视为不可安全遍历。 */
export const MAX_DEPTH = 256

/**
 * 计算字符串的 UTF-8 字节数。
 * 手写而非用 Buffer/TextEncoder，保证本模块零依赖、零全局对象。
 * @param {string} text - 任意字符串（孤立代理项按 3 字节计，只用于预算估算）。
 * @returns {number} 字节数。
 */
export function utf8Bytes(text) {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** 是否为普通 JSON 对象（非数组、非 null）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 编译用户规则。
 *
 * 每条原始规则的形状（=== cordis.patch.yml 里的 `config.rules[]`）：
 * ```yaml
 * - id: pii-phone              # 必填，稳定标识（日志里只出现它）
 *   match: '13800138000'       # 字面量；或 { regex: '1[3-9]\\d{9}', flags: 'g' }
 *   action: replace            # replace（默认）| block
 *   replacement: '[已移除]'     # 默认 '[已移除]'
 *   tools: [web_search]        # 工具名过滤；空数组 = 全部工具
 * ```
 *
 * @param {readonly unknown[]} rawRules - 原始规则数组。
 * @returns {{ rules: object[], problems: string[] }} 编译结果与全部问题（不抛异常，便于测试）。
 */
export function compileRules(rawRules) {
  const rules = []
  const problems = []
  const list = Array.isArray(rawRules) ? rawRules : []
  const seen = new Set()
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    const fallbackId = `#${index + 1}`
    if (!isRecord(raw)) {
      problems.push(`rules[${index}]: 必须是对象`)
      continue
    }
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
    if (id === undefined) problems.push(`rules[${index}]: 缺少非空字符串 id`)
    if (id !== undefined && seen.has(id)) problems.push(`rules[${index}] (${id}): id 重复`)
    if (id !== undefined) seen.add(id)
    const label = id ?? fallbackId

    const action = raw.action === undefined ? ACTION_REPLACE : raw.action
    if (action !== ACTION_REPLACE && action !== ACTION_BLOCK) {
      problems.push(`rules[${index}] (${label}): action 只能是 replace 或 block（得到 ${String(action)}）`)
      continue
    }

    const replacement = raw.replacement === undefined ? DEFAULT_REPLACEMENT : raw.replacement
    if (typeof replacement !== 'string') {
      problems.push(`rules[${index}] (${label}): replacement 必须是字符串`)
      continue
    }

    const tools = []
    if (raw.tools !== undefined) {
      if (!Array.isArray(raw.tools) || raw.tools.some((entry) => typeof entry !== 'string')) {
        problems.push(`rules[${index}] (${label}): tools 必须是字符串数组`)
        continue
      }
      tools.push(...raw.tools)
    }

    const matcher = compileMatcher(raw.match, index, label, problems)
    if (matcher === undefined) continue

    rules.push({
      id: label,
      action,
      replacement,
      tools,
      kind: matcher.kind,
      literal: matcher.literal,
      regex: matcher.regex,
    })
  }
  return { rules, problems }
}

/**
 * 编译一条规则的匹配器：字面量（`'abc'` / `{ literal }`）或正则（`{ regex, flags }`）。
 * @returns {{kind:'literal',literal:string}|{kind:'regex',regex:RegExp}|undefined} 匹配器。
 */
function compileMatcher(match, index, label, problems) {
  if (typeof match === 'string') {
    if (match.length === 0) {
      problems.push(`rules[${index}] (${label}): 字面量不能为空字符串（会命中一切）`)
      return undefined
    }
    return { kind: 'literal', literal: match }
  }
  if (!isRecord(match)) {
    problems.push(`rules[${index}] (${label}): match 必须是字符串或 { literal } / { regex, flags }`)
    return undefined
  }
  const hasLiteral = Object.hasOwn(match, 'literal')
  const hasRegex = Object.hasOwn(match, 'regex')
  if (hasLiteral === hasRegex) {
    problems.push(`rules[${index}] (${label}): match 必须且只能给出 literal 或 regex 之一`)
    return undefined
  }
  if (hasLiteral) {
    if (typeof match.literal !== 'string' || match.literal.length === 0) {
      problems.push(`rules[${index}] (${label}): match.literal 必须是非空字符串`)
      return undefined
    }
    return { kind: 'literal', literal: match.literal }
  }
  if (typeof match.regex !== 'string' || match.regex.length === 0) {
    problems.push(`rules[${index}] (${label}): match.regex 必须是非空字符串`)
    return undefined
  }
  let flags = match.flags === undefined ? '' : match.flags
  if (typeof flags !== 'string') {
    problems.push(`rules[${index}] (${label}): match.flags 必须是字符串`)
    return undefined
  }
  // 改写与计数都要求全局匹配；用户给不给 'g' 都由引擎补齐。
  if (!flags.includes('g')) flags += 'g'
  let regex
  try {
    regex = new RegExp(match.regex, flags)
  } catch (error) {
    problems.push(`rules[${index}] (${label}): 正则无法编译（${String(error && error.message)}）`)
    return undefined
  }
  return { kind: 'regex', regex }
}

/**
 * 创建一次调用的扫描预算。
 * @param {number} maxScannedBytes - 上限（字节）；`Infinity` 表示不限制。
 * @returns {{max:number, used:number, exhausted:boolean}} 预算对象（会被就地消耗）。
 */
export function createBudget(maxScannedBytes) {
  return {
    max: Number.isFinite(maxScannedBytes) ? maxScannedBytes : Infinity,
    used: 0,
    exhausted: false,
  }
}

/** 记账：预算够则扣减并返回 true；不够则标记耗尽并返回 false。 */
function consume(budget, bytes) {
  if (budget === undefined) return true
  if (budget.exhausted) return false
  if (budget.used + bytes > budget.max) {
    budget.exhausted = true
    return false
  }
  budget.used += bytes
  return true
}

/** 统计不重叠的字面量出现次数。 */
function countLiteral(text, literal) {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(literal, from)
    if (at < 0) return count
    count += 1
    from = at + literal.length
  }
}

/** 统计正则命中次数（显式推进 lastIndex，零宽匹配也不会死循环）。 */
function countRegex(text, regex) {
  regex.lastIndex = 0
  let count = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    count += 1
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return count
}

/**
 * 用一条规则改写文本。**替换串按字面量插入**（用函数式 replacer，不做 `$&`/`$1` 展开，
 * 否则 replacement 里的 `$&` 会把命中文本原样写回去）。
 */
function rewriteWithRule(text, rule) {
  if (rule.kind === 'literal') {
    const count = countLiteral(text, rule.literal)
    if (count === 0) return { text, count }
    return { text: text.split(rule.literal).join(rule.replacement), count }
  }
  rule.regex.lastIndex = 0
  let count = 0
  const next = text.replace(rule.regex, () => {
    count += 1
    return rule.replacement
  })
  return { text: count === 0 ? text : next, count }
}

/** 对一段文本依次执行全部规则（探测模式只计数）。 */
function applyRules(text, rules, budget, mode) {
  let out = text
  let total = 0
  const hits = []
  for (const rule of rules) {
    if (mode === 'rewrite' && rule.action !== ACTION_REPLACE) continue
    if (rule.kind === 'literal') {
      const count = countLiteral(out, rule.literal)
      if (count === 0) continue
      hits.push({ id: rule.id, count })
      total += count
      if (mode === 'rewrite') out = out.split(rule.literal).join(rule.replacement)
    } else if (mode === 'rewrite') {
      const result = rewriteWithRule(out, rule)
      if (result.count === 0) continue
      hits.push({ id: rule.id, count: result.count })
      total += result.count
      out = result.text
    } else {
      const count = countRegex(out, rule.regex)
      if (count === 0) continue
      hits.push({ id: rule.id, count })
      total += count
    }
  }
  return { text: out, hits, total }
}

/** 该字符串叶子是否被 schema 的 enum/const 固定（改写必然违约）。 */
function isPinnedString(schemas, depth) {
  if (depth > 8) return false
  for (const schema of schemas) {
    if (!isRecord(schema)) continue
    if (Object.hasOwn(schema, 'const') || Object.hasOwn(schema, 'enum')) return true
    if (Array.isArray(schema.oneOf) && isPinnedString(schema.oneOf, depth + 1)) return true
  }
  return false
}

/** 解析对象某个键对应的候选 schema（properties 优先，其次 additionalProperties）。 */
function schemasForKey(schemas, key) {
  const out = []
  for (const schema of schemas) {
    if (!isRecord(schema)) continue
    if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) {
      out.push(schema.properties[key])
      continue
    }
    if (isRecord(schema.additionalProperties)) out.push(schema.additionalProperties)
    if (Array.isArray(schema.oneOf)) {
      const nested = schemasForKey(schema.oneOf, key)
      for (const entry of nested) out.push(entry)
    }
  }
  return out
}

/** 解析数组元素对应的候选 schema。 */
function schemasForItems(schemas) {
  const out = []
  for (const schema of schemas) {
    if (!isRecord(schema)) continue
    if (isRecord(schema.items)) out.push(schema.items)
    if (Array.isArray(schema.oneOf)) {
      const nested = schemasForItems(schema.oneOf)
      for (const entry of nested) out.push(entry)
    }
  }
  return out
}

/** 一次遍历的可变状态。 */
function createState(options) {
  const rules = Array.isArray(options.rules) ? options.rules : []
  return {
    rules: { replace: rules.filter((rule) => rule.action === ACTION_REPLACE), detect: rules },
    mode: options.mode === 'detect' ? 'detect' : 'rewrite',
    budget: options.budget,
    hits: new Map(),
    pinned: 0,
    skipped: 0,
    unsafe: 0,
    truncated: false,
  }
}

/** 记账一条命中。 */
function record(state, hits) {
  for (const hit of hits) state.hits.set(hit.id, (state.hits.get(hit.id) ?? 0) + hit.count)
}

/** 清洗一个字符串叶子（按模式选择规则集）。 */
function scrubLeaf(text, schemas, state) {
  if (state.mode === 'rewrite' && schemas.length > 0 && isPinnedString(schemas, 0)) {
    state.pinned += 1
    return text
  }
  if (!consume(state.budget, utf8Bytes(text))) {
    state.skipped += 1
    state.truncated = true
    return text
  }
  const rules = state.mode === 'rewrite' ? state.rules.replace : state.rules.detect
  if (rules.length === 0) return text
  const result = applyRules(text, rules, state.budget, state.mode)
  if (result.total > 0) record(state, result.hits)
  return result.text
}

/**
 * 深度遍历一个无损 JSON 值，只改写其中的字符串叶子。
 * @returns {unknown} 改写后的值；无变化时**按引用返回原值**（便于上层走同一性快路径）。
 */
function walkValue(node, schemas, state, depth) {
  if (typeof node === 'string') return scrubLeaf(node, schemas, state)
  if (depth > MAX_DEPTH) {
    state.unsafe += 1
    state.skipped += 1
    return node
  }
  if (Array.isArray(node)) {
    const itemSchemas = schemasForItems(schemas)
    let out = node
    for (let index = 0; index < node.length; index += 1) {
      const next = walkValue(node[index], itemSchemas, state, depth + 1)
      if (next !== node[index]) {
        if (out === node) out = node.slice()
        out[index] = next
      }
    }
    return out
  }
  if (isRecord(node)) {
    let out = node
    for (const key of Object.keys(node)) {
      const next = walkValue(node[key], schemasForKey(schemas, key), state, depth + 1)
      if (next !== node[key]) {
        if (out === node) out = { ...node }
        out[key] = next
      }
    }
    return out
  }
  if (node === null || typeof node === 'number' || typeof node === 'boolean') return node
  // undefined / function / symbol / bigint：不是无损 JSON，无法安全遍历。
  state.unsafe += 1
  state.skipped += 1
  return node
}

/** 清洗内容块数组（text/reasoning 的 text 字段，以及 tool-result 的嵌套 content）。 */
function walkBlocks(blocks, state, depth) {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) {
    if (depth > MAX_DEPTH) state.unsafe += 1
    return blocks
  }
  let out = blocks
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!isRecord(block)) continue
    let next = block
    if (typeof block.text === 'string') {
      const text = scrubLeaf(block.text, [], state)
      if (text !== block.text) next = { ...next, text }
    }
    if (Array.isArray(block.content)) {
      const nested = walkBlocks(block.content, state, depth + 1)
      if (nested !== block.content) next = { ...next, content: nested }
    }
    if (next !== block) {
      if (out === blocks) out = blocks.slice()
      out[index] = next
    }
  }
  return out
}

/** 汇总报告（命中只以 规则 id + 计数 形式出现，绝不包含命中文本）。 */
function finalize(state, value, source) {
  const hits = [...state.hits].map(([id, count]) => ({ id, count }))
  const matched = hits.length > 0
  return {
    value,
    matched,
    changed: matched && state.mode === 'rewrite' && value !== source,
    hits,
    totalHits: hits.reduce((sum, hit) => sum + hit.count, 0),
    pinned: state.pinned,
    skipped: state.skipped,
    unsafe: state.unsafe,
    truncated: state.truncated,
    scannedBytes: state.budget === undefined ? 0 : state.budget.used,
  }
}

/**
 * 清洗一个无损 JSON 值（工具的成功返回值）。
 * @param {unknown} value - 工具声明的 canonical value（已被注册表快照并深冻结）。
 * @param {{rules: object[], schema?: unknown, budget?: object, mode?: 'rewrite'|'detect'}} options - 规则、输出 schema、预算、模式。
 * @returns {object} 报告：`{ value, changed, hits, totalHits, pinned, skipped, unsafe, truncated, scannedBytes }`。
 */
export function scrubValue(value, options) {
  const state = createState(options)
  const schemas = options.schema === undefined ? [] : [options.schema]
  const next = walkValue(value, schemas, state, 0)
  return finalize(state, next, value)
}

/**
 * 清洗内容块数组（失败结果或 `tool/ptc-dispatch` 的持久化副本）。
 * @param {readonly object[]} blocks - ContentBlock[]。
 * @param {{rules: object[], budget?: object, mode?: 'rewrite'|'detect'}} options - 规则、预算、模式。
 * @returns {object} 与 {@link scrubValue} 同形的报告。
 */
export function scrubContentBlocks(blocks, options) {
  const state = createState(options)
  const next = walkBlocks(blocks, state, 0)
  return finalize(state, next, blocks)
}

/**
 * 只探测不改写（用于"参数命中即阻断"：参数无法改写，只能拒绝执行）。
 * @param {unknown} value - 待探测的无损 JSON 值（通常是 `exec.arguments`）。
 * @param {{rules: object[], budget?: object}} options - 规则与预算（只使用 action='block' 的规则由调用方过滤）。
 * @returns {object} 报告；`value` 恒为原值。
 */
export function detectValue(value, options) {
  return scrubValue(value, { ...options, mode: 'detect' })
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构最小化（strip）
//
// 与上面的正则引擎互补：strip **内容无关**，它不认识任何敏感词，只回答一个问题 ——
// "这个字段该不该留在结果里"。用于"事先无法枚举"的第三方文本（公开检索回来的
// 任意段落）：不去猜它是什么，直接让庞大的、未经审查的载荷**根本不进入** value，
// 于是既不进 content（渲染）、也不进 presentationMeta（持久化 meta）。
// ─────────────────────────────────────────────────────────────────────────────

/** 截断保留头部时追加的省略标记（不含被省略文本的任何片段）。 */
export const STRIP_MARKER = '[已省略]'

/** `strip[].path` 的最大段数（路径来自配置，仍设一个防御性上限）。 */
export const MAX_STRIP_SEGMENTS = 32

/** 无法应用一条 strip 规则的原因码：目标键在 schema 的 `required` 里（丢弃会违约）。 */
export const STRIP_REASON_REQUIRED = 'required-field'
/** 无法应用的原因码：给了 `maxChars`，但目标不是字符串。 */
export const STRIP_REASON_NON_STRING = 'non-string'
/** 无法应用的原因码：给了 `maxChars`，但目标值被 schema 的 `enum`/`const` 固定（截断必然违约）。 */
export const STRIP_REASON_PINNED = 'pinned-value'

/**
 * `web_search` 的内置结构最小化规则（`stripDefaults: true` 时自动追加在用户规则之前）。
 *
 * 两条路径都对着 shipped 的 `web_search` 输出 schema 核过
 * （`dsh-tool-web/lib/index.js:270-298`）：`required` 只有 `sources` 与 `truncated`，
 * `content`、`sources[].title`、`sources[].snippet`、`sources[].publishedAt` 都是可选的
 * （`sources[].url` 才是必需）。所以删 `sources.*.snippet` 与 `content` 不会违约，
 * 而删 `sources`/`truncated`/`sources.*.url` 会被引擎**拒绝**（见下面的 refuse 分支）。
 *
 * 删掉之后，渲染（`formatSearchOutput`，`:62-79`，逐处 `!== void 0` 判断）与
 * presentationMeta（`searchMetaFromValue`/`projectSource`，`:103-124`）都会把这两个字段
 * 当作"不存在"处理 —— 于是 meta 里也不再有 snippet/answer。
 */
export const WEB_SEARCH_STRIP_DEFAULTS = Object.freeze([
  Object.freeze({ id: 'web-search-snippet', tool: 'web_search', path: 'sources.*.snippet' }),
  Object.freeze({ id: 'web-search-answer', tool: 'web_search', path: 'content' }),
])

/**
 * 编译用户给出的 strip 规则。
 *
 * 每条原始规则的形状（=== cordis.patch.yml 里的 `config.strip[]`）：
 * ```yaml
 * - id: web-search-snippet     # 必填，稳定标识（日志里只出现它）
 *   tool: web_search           # 工具名；'*'（默认）= 所有工具
 *   path: sources.*.snippet    # 点分路径，`*` 是数组通配段
 *   maxChars: 200              # 可选：超过该长度就只留头部 + 省略标记；不给则整字段丢弃
 * ```
 *
 * @param {readonly unknown[]} rawRules - 原始 strip 规则数组。
 * @returns {{ rules: object[], problems: string[] }} 编译结果与全部问题（不抛异常，便于测试）。
 */
export function compileStripRules(rawRules) {
  const rules = []
  const problems = []
  const list = Array.isArray(rawRules) ? rawRules : []
  const seen = new Set()
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    if (!isRecord(raw)) {
      problems.push(`strip[${index}]: 必须是对象`)
      continue
    }
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
    if (id === undefined) problems.push(`strip[${index}]: 缺少非空字符串 id`)
    if (id !== undefined && seen.has(id)) problems.push(`strip[${index}] (${id}): id 重复`)
    if (id !== undefined) seen.add(id)
    const label = id ?? `#${index + 1}`

    let tool = '*'
    if (raw.tool !== undefined) {
      if (typeof raw.tool !== 'string' || raw.tool.length === 0) {
        problems.push(`strip[${index}] (${label}): tool 必须是非空字符串（'*' = 所有工具）`)
        continue
      }
      tool = raw.tool
    }

    const segments = compileStripPath(raw.path, index, label, problems)
    if (segments === undefined) continue

    let maxChars
    if (raw.maxChars !== undefined) {
      if (typeof raw.maxChars !== 'number' || !Number.isInteger(raw.maxChars) || raw.maxChars < 1) {
        problems.push(`strip[${index}] (${label}): maxChars 必须是 >= 1 的整数（得到 ${String(raw.maxChars)}）`)
        continue
      }
      maxChars = raw.maxChars
    }

    rules.push({ id: label, tool, path: raw.path, segments, maxChars })
  }
  return { rules, problems }
}

/** 编译一条 strip 路径为段数组：`a.b`、`a.*.b`、`*`。 */
function compileStripPath(path, index, label, problems) {
  if (typeof path !== 'string' || path.length === 0) {
    problems.push(`strip[${index}] (${label}): path 必须是非空字符串（点分路径，'*' 为数组通配段）`)
    return undefined
  }
  const segments = path.split('.')
  if (segments.length > MAX_STRIP_SEGMENTS) {
    problems.push(`strip[${index}] (${label}): path 最多 ${MAX_STRIP_SEGMENTS} 段（得到 ${segments.length} 段）`)
    return undefined
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      problems.push(`strip[${index}] (${label}): path 存在空段（${path}）`)
      return undefined
    }
    if (segment.includes('*') && segment !== '*') {
      problems.push(`strip[${index}] (${label}): path 里的 * 必须是独立的一段（得到 "${segment}"）`)
      return undefined
    }
  }
  return segments
}

/** 收集候选 schema 声明的 `required` 键（递归 oneOf 分支；任一声明即视为必需）。 */
function requiredKeysOf(schemas, depth = 0) {
  const out = new Set()
  if (depth > 8) return out
  for (const schema of schemas) {
    if (!isRecord(schema)) continue
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === 'string') out.add(key)
    }
    if (Array.isArray(schema.oneOf)) {
      for (const key of requiredKeysOf(schema.oneOf, depth + 1)) out.add(key)
    }
  }
  return out
}

/** 是否为可安全遍历的无损 JSON 节点（`undefined`/函数/符号/bigint 不是）。 */
function isLosslessNode(node) {
  if (node === null) return true
  const type = typeof node
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'object'
}

/**
 * 按 **Unicode 码位**取头部，绝不断开代理对。
 * 手写循环而非 `Array.from`：值可能很大，这里不想为大字符串再分配一个数组。
 * @param {string} text - 原字符串。
 * @param {number} maxChars - 最多保留多少个码位。
 * @returns {string} 头部（原字符串的前缀；长度不足时**原样返回**）。
 */
export function headByCodePoints(text, maxChars) {
  let index = 0
  let taken = 0
  while (index < text.length && taken < maxChars) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1
    taken += 1
  }
  return text.slice(0, index)
}

/** 记一次成功应用（丢弃或截断）。 */
function recordStrip(state, rule, count) {
  state.hits.set(rule.id, (state.hits.get(rule.id) ?? 0) + count)
}

/** 记一次"规则无法应用"（绝不静默产出非法值，由上层决定降级还是放行）。 */
function refuseStrip(state, rule, reason) {
  state.refused += 1
  const key = `${rule.id}\u0000${rule.path}\u0000${reason}`
  const entry = state.refusals.get(key)
  if (entry === undefined) {
    state.refusals.set(key, { id: rule.id, tool: rule.tool, path: rule.path, reason, count: 1 })
  } else entry.count += 1
}

/**
 * 处理一条规则的**终止段**：决定"整字段丢弃"还是"截断保留头部"。
 *
 * 判定顺序（每一步都有 schema 依据，见 README 的校对表）：
 * 1. 没有 `maxChars` ⇒ 丢弃。目标键在 `required` 里就必须**拒绝**：注册表会以
 *    `missing required property` 判违约（`dsh-tools/lib/index.js:454-455`）。
 * 2. 有 `maxChars` 但目标不是字符串 ⇒ 拒绝（`maxChars` 只对字符串有意义）。
 * 3. 有 `maxChars` 且目标值被 `enum`/`const` 固定 ⇒ 拒绝（截断必然违约；
 *    注意：**丢弃**不受此限 —— `enum` 约束的是"值"，不是"键是否存在"）。
 * 4. 长度未超过 `maxChars` ⇒ 一字不动（保持原引用，走同一性快路径）。
 * 5. 否则保留头 + 省略标记；保留的字节计入预算。`required` 的字符串字段可以截断：
 *    它仍然存在、仍然是字符串，而受支持的 schema 子集里没有 `minLength`/`maxLength`
 *    （`dsh-tools/lib/index.js:33-42`）。
 */
function stripTerminal(parent, key, child, childSchemas, parentSchemas, rule, state) {
  if (rule.maxChars === undefined) {
    if (requiredKeysOf(parentSchemas).has(key)) {
      refuseStrip(state, rule, STRIP_REASON_REQUIRED)
      return parent
    }
    recordStrip(state, rule, 1)
    state.dropped += 1
    const next = { ...parent }
    delete next[key]
    return next
  }
  if (typeof child !== 'string') {
    refuseStrip(state, rule, STRIP_REASON_NON_STRING)
    return parent
  }
  if (childSchemas.length > 0 && isPinnedString(childSchemas, 0)) {
    refuseStrip(state, rule, STRIP_REASON_PINNED)
    return parent
  }
  const head = headByCodePoints(child, rule.maxChars)
  if (head.length === child.length) {
    state.kept += 1
    return parent
  }
  // 预算记账的口径与正则引擎不同：strip 按**保留下来**的原文字节记账
  // （整字段丢弃记 0 —— 丢弃不需要读取内容，也不该被超长内容挡住）。
  if (!consume(state.budget, utf8Bytes(head))) {
    state.skipped += 1
    state.truncated = true
    return parent
  }
  recordStrip(state, rule, 1)
  state.truncatedFields += 1
  return { ...parent, [key]: `${head}${STRIP_MARKER}` }
}

/**
 * 沿一条规则的路径下潜，返回改写后的节点（无改动时按引用返回原节点）。
 * @param {unknown} node - 当前节点。
 * @param {object[]} schemas - 当前节点对应的候选 schema 列表（可能为空 = 无从判断）。
 * @param {object} rule - 已编译的 strip 规则。
 * @param {number} index - 当前段下标。
 * @param {object} state - 本次遍历的可变状态。
 * @returns {unknown} 改写后的节点。
 */
function stripAt(node, schemas, rule, index, state) {
  if (!isLosslessNode(node)) {
    state.unsafe += 1
    state.skipped += 1
    return node
  }
  const segment = rule.segments[index]
  const last = index === rule.segments.length - 1

  if (segment === '*') {
    if (!Array.isArray(node)) {
      state.missing += 1
      return node
    }
    if (last) {
      // 终止段是 `*` ⇒ 清空这个数组。数组里的元素不是对象的"必需键"，
      // 且受支持的 schema 子集没有 minItems，所以清空永远合法。
      if (node.length === 0) {
        state.missing += 1
        return node
      }
      recordStrip(state, rule, node.length)
      state.dropped += node.length
      return []
    }
    const itemSchemas = schemasForItems(schemas)
    let out = node
    for (let position = 0; position < node.length; position += 1) {
      const next = stripAt(node[position], itemSchemas, rule, index + 1, state)
      if (next !== node[position]) {
        if (out === node) out = node.slice()
        out[position] = next
      }
    }
    return out
  }

  if (!isRecord(node)) {
    state.missing += 1
    return node
  }
  if (!Object.hasOwn(node, segment) || node[segment] === undefined) {
    // 字段本来就不存在（web_search 的 content/snippet 都是可选的）⇒ 无事可做。
    state.missing += 1
    return node
  }
  const childSchemas = schemasForKey(schemas, segment)
  if (!last) {
    const next = stripAt(node[segment], childSchemas, rule, index + 1, state)
    if (next === node[segment]) return node
    return { ...node, [segment]: next }
  }
  return stripTerminal(node, segment, node[segment], childSchemas, schemas, rule, state)
}

/** 汇总 strip 报告。 */
function finalizeStrip(state, value, source) {
  const hits = [...state.hits].map(([id, count]) => ({ id, count }))
  const refusals = [...state.refusals.values()]
  return {
    value,
    changed: value !== source,
    matched: hits.length > 0,
    hits,
    totalHits: hits.reduce((sum, hit) => sum + hit.count, 0),
    dropped: state.dropped,
    truncatedFields: state.truncatedFields,
    kept: state.kept,
    missing: state.missing,
    refusals,
    refused: state.refused,
    skipped: state.skipped,
    unsafe: state.unsafe,
    truncated: state.truncated,
    scannedBytes: state.budget === undefined ? 0 : state.budget.used,
  }
}

/**
 * 结构最小化：按字段路径丢弃/截断一个无损 JSON 值里的字段。
 *
 * 与 {@link scrubValue} 一样**只读不改**：无改动时**按引用返回原值**
 * （注册表据此走同一性快路径，`dsh-tools/lib/index.js:3448`）。
 *
 * @param {unknown} value - 工具的成功返回值（canonical value）。
 * @param {{rules: object[], schema?: unknown, budget?: object}} options - 规则、输出 schema、预算。
 * @returns {object} 报告：`{ value, changed, hits, totalHits, dropped, truncatedFields, kept, missing, refusals, refused, skipped, unsafe, truncated, scannedBytes }`。
 */
export function stripValue(value, options) {
  const rules = Array.isArray(options.rules) ? options.rules : []
  const state = {
    budget: options.budget,
    hits: new Map(),
    refusals: new Map(),
    dropped: 0,
    truncatedFields: 0,
    kept: 0,
    missing: 0,
    skipped: 0,
    unsafe: 0,
    refused: 0,
    truncated: false,
  }
  if (rules.length === 0) return finalizeStrip(state, value, value)
  const schemas = options.schema === undefined ? [] : [options.schema]
  let out = value
  for (const rule of rules) {
    // 规则**依次**作用在前一条的结果上：后一条看到的是已经最小化过的值。
    out = stripAt(out, schemas, rule, 0, state)
  }
  return finalizeStrip(state, out, value)
}

/**
 * 把"规则无法应用"的报告渲染成一行**不含任何内容**的摘要（只有原因码与计数）。
 * @param {readonly {reason:string,count:number}[]} refusals - `report.refusals`。
 * @returns {string} 形如 `required-field×1, pinned-value×2`。
 */
export function describeRefusals(refusals) {
  const counts = new Map()
  for (const entry of Array.isArray(refusals) ? refusals : []) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + entry.count)
  }
  return [...counts].map(([reason, count]) => `${reason}×${count}`).join(', ')
}

/**
 * 把命中报告渲染成一行**不含命中文本**的摘要。
 * @param {readonly {id:string,count:number}[]} hits - 命中报告。
 * @returns {string} 形如 `pii×3, secret×1`。
 */
export function describeHits(hits) {
  return hits.map((hit) => `${hit.id}×${hit.count}`).join(', ')
}
