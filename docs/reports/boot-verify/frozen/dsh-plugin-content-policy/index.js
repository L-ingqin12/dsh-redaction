/**
 * dsh-plugin-content-policy —— DSH 工具结果的**预防式**内容策略。
 *
 * 为什么存在
 * ----------
 * 一次 `session.append('tool/result', data)` 有两个后果：它既是**持久日志**，也是
 * **将来每一次 provider 请求里的那条消息** —— `dsh-session/lib/index.js:216`
 * 的 `deriveEventMessage` 对 `tool/result` 直接返回 `event.data.message`，而 agent loop
 * 的请求由 `session.deriveMessages()` 折叠同一批事件得到。所以"不该留存的内容"
 * 必须在 append **之前**处理掉。本插件不是事后补救（那是 `dsh-plugin-redact`
 * 的活），而是在结果被规范化/落盘之前改写它。
 *
 * 规则驱动、内容无关
 * ------------------
 * 引擎自己不认识任何敏感词：用户给规则（字面量或正则），引擎只负责"定位 + 改写"，
 * 并且**只输出计数、规则 id、工具名，永远不输出命中的文本**。
 *
 * 两条互补的策略（同一条 `tools/execute` 接缝，**先 strip 后正则**）
 * ---------------------------------------------------------------
 * - `strip[]`：**结构最小化**。按字段路径（`sources.*.snippet`、`content`）把整个字段
 *   丢弃或截断。适用场景是"事先无法枚举"的文本（公开检索回来的任意段落）：
 *   不判断它是什么，只让它**根本不进入 value**。因为注册表从 value 重新派生
 *   content 与 meta，所以它既不进渲染文本、也不进持久化的 presentationMeta。
 * - `rules[]`：**内容改写**。已有的字面量/正则引擎。
 *
 * 顺序是 **strip 先、正则后**，理由有两条：① strip 是最可靠、最省的那一步，如果让正则
 * 先跑，一段 200 KB 的 snippet 会先吃掉整个扫描预算，strip 反而因预算用尽被跳过 ——
 * 该丢的载荷就活下来了；② 被丢掉字段里的文本本来就不该再被逐处改写，先丢再扫还能省下
 * 扫描开销。代价是"被 strip 掉的字段不再参与正则规则"，这正是本策略的意图。
 *
 * 三条接缝（全部逐条对照过 shipped 源码，见 README.zh.md 的接缝表）
 * ------------------------------------------------------------------
 * 1. `tools/execute` 瀑布（主接缝，`dsh-tools/lib/types/index.d.ts:49`）。
 *    包装器的返回值会被 `normalizeDispatchResult` 重新规范化
 *    （`dsh-tools/lib/index.js:3213-3214`、`:3447`）：成功结果会**从 `value`
 *    重新派生 content 与 meta**（`:3458` → `:3415`）。因此本插件改写的是 `value`，
 *    不是 `content` —— 只换 `content` 会在 `{...result}` 里留下原样的 `meta`
 *    （`:3401-3405`），而 `meta` 是会被持久化的（`dsh-agent-loop/lib/index.js:708`）。
 *    `web_search` 正是把同一段 snippet 同时放进 content 与 presentationMeta
 *    （`dsh-tool-web/lib/index.js:62-79`、`:103-124`）的例子。
 * 2. 失败结果走 `:3449-3455`：content/meta 逐字复制，所以本插件返回自己构造的
 *    `{ isError: true, error, content }` 并**故意不带 `meta`**（meta 是丢掉的，
 *    不是改写的）—— 失败结果不能替换 value（`:3392`）。strip 只作用于成功结果的
 *    `value`，因此对失败结果不生效；失败结果仍由正则规则处理 content/error.message。
 * 3. `tools/ptc-dispatch-log` 瀑布：给 `run_code` 子调用**持久化日志副本**兜底。
 *    这条接缝只拿得到 content 块（`dsh-tools/lib/index.js:1235-1242`），没有 value，
 *    所以 strip 在这条接缝上无从下手（日志副本只能靠正则规则改写文本）。
 *
 * 默认是真空操作
 * --------------
 * 未配置 `rules` **且**未配置 `strip`（或 `enabled: false`）时**不注册任何监听器**，
 * 与 `dsh-spill-policy` 的 "omitted config ⇒ the plugin registers nothing" 约定一致。
 *
 * @module dsh-plugin-content-policy
 */

import { randomUUID } from 'node:crypto'
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
  scrubContentBlocks,
  scrubValue,
  stripValue,
} from './lib/scrub.mjs'

/** Cordis loader 诊断用的插件名。 */
export const name = 'content-policy'
/** 只消费工具注册表：`tools/execute` / `tools/pre-execute` / `tools/ptc-dispatch-log`。 */
export const inject = ['tools']

export { DEFAULT_REPLACEMENT, STRIP_MARKER, WEB_SEARCH_STRIP_DEFAULTS }

/** 本插件自有失败的稳定 code（会随 `error.info` 持久化）。 */
export const POLICY_CODE = 'CONTENT_POLICY'
/** 自有失败的 error.name。 */
const POLICY_ERROR_NAME = 'ContentPolicyError'

/** `maxScannedBytes` 默认值：4 MiB。 */
const DEFAULT_MAX_SCANNED_BYTES = 4 * 1024 * 1024

/** 通知文本的长度上限（它本身也会进入会话）。 */
const NOTICE_LIMIT = 400

/** strip 拒绝原因码 → 中文说明（只说原因，不含任何被处理的内容）。 */
const STRIP_REASON_TEXT = {
  [STRIP_REASON_REQUIRED]: '该字段在输出 schema 的 required 里，丢弃会让注册表的校验失败',
  [STRIP_REASON_NON_STRING]: '给了 maxChars，但目标不是字符串',
  [STRIP_REASON_PINNED]: '目标值被输出 schema 的 enum/const 固定，截断会违约',
}

/**
 * 配置字段表 —— Schemastery 与内置兜底校验器**共用同一份定义**，避免两处漂移。
 * `type` 取值：boolean | enum | rules | strip | number。
 */
const FIELDS = [
  {
    key: 'enabled',
    type: 'boolean',
    default: true,
    description: '总开关。false ⇒ 与未配置一样，不注册任何监听器。',
  },
  {
    key: 'rules',
    type: 'rules',
    default: [],
    description: '内容改写规则列表（字面量/正则）。空数组 ⇒ 不注册这一路的监听器。',
  },
  {
    key: 'strip',
    type: 'strip',
    default: [],
    description: '结构最小化规则列表（按字段路径整段丢弃/截断）。空数组 ⇒ 不注册这一路的监听器。',
  },
  {
    key: 'stripDefaults',
    type: 'boolean',
    default: false,
    description: 'true ⇒ 自动追加内置的 web_search 最小化规则（丢弃 sources.*.snippet 与 content 答案）。',
  },
  {
    key: 'maxScannedBytes',
    type: 'number',
    default: DEFAULT_MAX_SCANNED_BYTES,
    description: '单次调用允许扫描（正则）/保留（strip 截断）的 UTF-8 字节上限；正整数，Infinity（YAML `.inf`）表示不限。',
  },
  {
    key: 'onBudgetExceeded',
    type: 'enum',
    values: ['partial', 'error'],
    default: 'partial',
    description: '预算用尽时的策略：partial 停止扫描并保留（部分改写）；error 整条结果降级为终态错误。',
  },
  {
    key: 'onUnsafeValue',
    type: 'enum',
    values: ['keep', 'error'],
    default: 'keep',
    description: '遇到无法安全遍历的节点时的策略：keep 原样保留该子树；error 整条结果降级为终态错误。',
  },
  {
    key: 'onStripRefused',
    type: 'enum',
    values: ['error', 'skip'],
    default: 'error',
    description: 'strip 规则无法应用时（目标是 required 字段、maxChars 撞上非字符串或 enum/const 固定值）：error 整条结果降级为终态错误（默认，绝不静默留下载荷）；skip 保留该字段并告警。',
  },
  {
    key: 'notify',
    type: 'boolean',
    default: true,
    description: '是否把"已改写/已截断/已最小化"的提示追加给模型（plugin 角色的 user 消息）；日志始终只记计数。',
  },
]

/**
 * Config 的构建。
 *
 * 这里刻意做成**双轨**：能解析到 `@deepseek-ai/schemastery` 时导出真正的
 * Schemastery schema（与 shipped 策略插件同形，`dsh --dump-config` / 设置界面
 * 能看到 description 与 default）；解析不到时退回本文件内置的 Standard Schema
 * 实现。原因是模块解析事实：插件以 `link:` 方式装进 profile 后，Node 从包的真实
 * 路径（`<插件目录>`）向上找 `node_modules`，而 `@deepseek-ai/*` 只存在于 DSH
 * 部署安装目录里，**从插件目录不可达**（详见 README.zh.md）。
 *
 * Cordis 只要求 `Config["~standard"].validate(config)`
 * （`cordis/lib/index.js:955-960`），所以两条轨道行为一致。
 */
const schemastery = await loadSchemastery()
export const Config = schemastery === undefined ? buildFallbackConfig() : buildSchemasteryConfig(schemastery)

/** 尝试加载 Schemastery；不可解析时返回 undefined（不抛出）。 */
async function loadSchemastery() {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    const z = loaded?.default
    return typeof z?.object === 'function' ? z : undefined
  } catch {
    return undefined
  }
}

/** 用 Schemastery 构建 Config（形状对照 dsh-spill-policy/lib/index.js:74）。 */
function buildSchemasteryConfig(z) {
  const Match = z.object({
    literal: z.string().description('字面量（与 match: "..." 等价）。'),
    regex: z.string().description('正则源码（与 literal 二选一）。'),
    flags: z.string().default('').description('正则 flags；缺少 g 时引擎自动补。'),
  })
  const Rule = z.object({
    id: z.string().required().description('稳定规则 id；日志与通知里只出现它。'),
    match: z.union([z.string(), Match]).required().description('字面量字符串，或 { literal } / { regex, flags }。'),
    action: z.union([ACTION_REPLACE, ACTION_BLOCK]).default(ACTION_REPLACE).description('replace 改写；block 命中即拒绝执行该工具调用。'),
    replacement: z.string().default(DEFAULT_REPLACEMENT).description('替换文本（按字面量插入，不做 $ 展开）。'),
    tools: z.array(z.string()).default([]).description('工具名白名单；空数组 = 所有工具。'),
  })
  const StripRule = z.object({
    id: z.string().required().description('稳定规则 id；日志与通知里只出现它。'),
    tool: z.string().default('*').description("工具名；'*' = 所有工具。"),
    path: z.string().required().description("点分字段路径，'*' 为数组通配段，例如 sources.*.snippet、content。"),
    maxChars: z.number().description('可选：目标字符串超过该长度（Unicode 码位）时只保留这么长的头部并追加省略标记；不给则整个字段被丢弃。'),
  })
  const shape = {
    rules: z.array(Rule).default([]).description(fieldDescription('rules')),
    strip: z.array(StripRule).default([]).description(fieldDescription('strip')),
  }
  for (const field of FIELDS) {
    if (field.key === 'rules' || field.key === 'strip') continue
    shape[field.key] = schemasteryField(z, field)
  }
  return z.object(shape).description('dsh-plugin-content-policy 配置。')
}

/** 按字段表构建单个 Schemastery 字段。 */
function schemasteryField(z, field) {
  if (field.type === 'boolean') return z.boolean().default(field.default).description(field.description)
  if (field.type === 'enum') return z.union(field.values).default(field.default).description(field.description)
  // `z.number()` 不接受 Infinity（实测报 "expected number"），而 `maxScannedBytes: .inf`
  // 是"不限预算"的逃生口，所以显式并入 const(Infinity)，与内置兜底校验器行为一致。
  return z.union([z.number(), z.const(Infinity)]).default(field.default).description(field.description)
}

/** 取字段表中的描述文本。 */
function fieldDescription(key) {
  return FIELDS.find((field) => field.key === key)?.description ?? ''
}

/**
 * 内置兜底：一个最小的 Standard Schema v1 实现，字段与默认值来自同一张 FIELDS 表。
 * 只在 Schemastery 不可解析时使用；`cordis/lib/index.js:955-960` 调用的是同一个
 * `~standard.validate`。
 */
function buildFallbackConfig() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-plugin-content-policy',
      validate(value) {
        const input = value === undefined || value === null ? {} : value
        if (typeof input !== 'object' || Array.isArray(input)) {
          return { issues: [{ message: '配置必须是对象' }] }
        }
        const issues = []
        const out = {}
        for (const field of FIELDS) {
          const given = input[field.key]
          if (given === undefined) {
            out[field.key] = field.default
            continue
          }
          if (field.type === 'boolean') {
            if (typeof given !== 'boolean') issues.push({ message: `${field.key} 必须是布尔值`, path: [field.key] })
            else out[field.key] = given
            continue
          }
          if (field.type === 'enum') {
            if (!field.values.includes(given)) {
              issues.push({ message: `${field.key} 只能是 ${field.values.join(' | ')}`, path: [field.key] })
            } else out[field.key] = given
            continue
          }
          if (field.type === 'number') {
            if (typeof given !== 'number' || Number.isNaN(given)) {
              issues.push({ message: `${field.key} 必须是数字`, path: [field.key] })
            } else out[field.key] = given
            continue
          }
          if (!Array.isArray(given)) {
            issues.push({ message: `${field.key} 必须是数组`, path: [field.key] })
            continue
          }
          out[field.key] = given
        }
        // rules / strip 的逐条浅校验；深层语义问题（正则编译、路径语法、id 重复等）
        // 交给 compileRules / compileStripRules，那里的报错信息更准确。
        const rawStrip = out.strip
        for (let index = 0; index < rawStrip.length; index += 1) {
          const rule = rawStrip[index]
          const path = ['strip', String(index)]
          if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
            issues.push({ message: 'strip 规则必须是对象', path })
            continue
          }
          if (typeof rule.id !== 'string' || rule.id.length === 0) {
            issues.push({ message: 'strip 规则缺少非空字符串 id', path })
          }
          if (typeof rule.path !== 'string' || rule.path.length === 0) {
            issues.push({ message: 'strip 规则缺少非空字符串 path', path })
          }
          if (rule.tool !== undefined && (typeof rule.tool !== 'string' || rule.tool.length === 0)) {
            issues.push({ message: "strip 规则的 tool 必须是非空字符串（'*' = 所有工具）", path })
          }
          if (rule.maxChars !== undefined && (typeof rule.maxChars !== 'number' || Number.isNaN(rule.maxChars))) {
            issues.push({ message: 'strip 规则的 maxChars 必须是数字', path })
          }
        }
        const rawRules = out.rules
        for (let index = 0; index < rawRules.length; index += 1) {
          const rule = rawRules[index]
          const path = ['rules', String(index)]
          if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
            issues.push({ message: '规则必须是对象', path })
            continue
          }
          if (typeof rule.id !== 'string' || rule.id.length === 0) {
            issues.push({ message: '规则缺少非空字符串 id', path })
          }
          if (rule.match === undefined) issues.push({ message: '规则缺少 match', path })
          if (rule.action !== undefined && rule.action !== ACTION_REPLACE && rule.action !== ACTION_BLOCK) {
            issues.push({ message: `action 只能是 ${ACTION_REPLACE} 或 ${ACTION_BLOCK}`, path })
          }
          if (rule.replacement !== undefined && typeof rule.replacement !== 'string') {
            issues.push({ message: 'replacement 必须是字符串', path })
          }
          if (rule.tools !== undefined && (!Array.isArray(rule.tools) || rule.tools.some((entry) => typeof entry !== 'string'))) {
            issues.push({ message: 'tools 必须是字符串数组', path })
          }
        }
        return issues.length > 0 ? { issues } : { value: out }
      },
    },
  }
}

/**
 * 注册内容策略。
 *
 * **真空操作约定**：`enabled === false`，或 `rules` 与 `strip` **都**为空 ⇒ 直接 return，
 * 一个监听器都不注册（`dsh-spill-policy/lib/index.js:104` 同款约定）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} [config] - 已经过 Config 校验/填默认值的配置。
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  if (settings.enabled === false) return
  const rawRules = Array.isArray(settings.rules) ? settings.rules : []
  // `stripDefaults: true` ⇒ 把内置的 web_search 规则**放在用户规则之前**：
  // 规则依次作用，用户规则因此看到的是已经最小化过的值（可以再补一刀）。
  const rawStrip = [
    ...settings.stripDefaults === true ? WEB_SEARCH_STRIP_DEFAULTS : [],
    ...Array.isArray(settings.strip) ? settings.strip : [],
  ]
  if (rawRules.length === 0 && rawStrip.length === 0) return

  const { rules, problems } = compileRules(rawRules)
  const { rules: stripRules, problems: stripProblems } = compileStripRules(rawStrip)
  const allProblems = [...problems, ...stripProblems]
  if (allProblems.length > 0) {
    throw new Error(`content-policy: 规则配置有误，已拒绝装配：\n  - ${allProblems.join('\n  - ')}`)
  }
  const maxScannedBytes = resolveMaxScannedBytes(settings.maxScannedBytes)
  const onBudgetExceeded = settings.onBudgetExceeded === 'error' ? 'error' : 'partial'
  const onUnsafeValue = settings.onUnsafeValue === 'error' ? 'error' : 'keep'
  // 默认 `error`：strip 规则撞上 required 字段时**绝不静默留下载荷**。
  const onStripRefused = settings.onStripRefused === 'skip' ? 'skip' : 'error'
  const notify = settings.notify !== false

  const replaceRules = rules.filter((rule) => rule.action === ACTION_REPLACE)
  const blockRules = rules.filter((rule) => rule.action === ACTION_BLOCK)

  /** 该工具适用的规则子集（`tools: []` = 全部）。 */
  const rulesFor = (toolName, list) =>
    list.filter((rule) => rule.tools.length === 0 || rule.tools.includes(toolName))

  /** 该工具适用的 strip 规则子集（`tool: '*'` = 全部）。 */
  const stripsFor = (toolName) =>
    stripRules.filter((rule) => rule.tool === '*' || rule.tool === toolName)

  /** 构造本插件自有的失败结果（= 终态错误结果）。 */
  const policyFailure = (message) => ({
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: POLICY_ERROR_NAME, code: POLICY_CODE } },
  })

  /**
   * 构造给模型看的提示消息。
   * 形状对照 shipped 生产者：`{ kind: 'plugin', plugin }` + 完整 user 消息
   * （`dsh-hooks-claude-code/lib/index.js:128`、`:207-215`；`createUserMessage`
   * 补的 `id`/`role` 由本插件自己补，因为这里不能 import `@deepseek-ai/dsh-llm`）。
   */
  const notice = (text) => ({
    id: randomUUID(),
    role: 'user',
    source: { kind: 'plugin', plugin: name },
    content: [{ type: 'text', text: text.length > NOTICE_LIMIT ? `${text.slice(0, NOTICE_LIMIT)}…` : text }],
  })

  /** 判定阻断子策略：预算/不可遍历是否要把整条结果降级为终态错误。 */
  const violation = (report) => {
    if (onBudgetExceeded === 'error' && report.truncated) {
      return `扫描预算 ${maxScannedBytes} 字节已用尽，剩余内容无法安全改写`
    }
    if (onUnsafeValue === 'error' && report.unsafe > 0) {
      return `结果中存在无法安全遍历的节点（${report.unsafe} 个）`
    }
    return undefined
  }

  /**
   * strip 的阻断子策略。**默认就会阻断**：一条规则撞上 required 字段意味着
   * "该丢的载荷丢不掉"，静默放行等于策略失效 —— 宁可把这一条结果降级为终态错误。
   */
  const stripViolation = (report) => {
    if (onBudgetExceeded === 'error' && report.truncated) {
      return `扫描预算 ${maxScannedBytes} 字节已用尽，剩余字段无法安全最小化`
    }
    if (onUnsafeValue === 'error' && report.unsafe > 0) {
      return `结果中存在无法安全遍历的节点（${report.unsafe} 个）`
    }
    if (onStripRefused === 'error' && report.refused > 0) {
      return `结构最小化规则无法应用：${describeRefusals(report.refusals)}（${report.refusals.map((entry) => `${entry.id} → ${entry.path}`).join('；')}）`
    }
    return undefined
  }

  /** 规则目标/原因的中文说明（只说配置与原因码，绝不含被处理的内容）。 */
  const refusalDetail = (report) => report.refusals
    .map((entry) => `${entry.id}（${entry.tool} · ${entry.path}）：${STRIP_REASON_TEXT[entry.reason] ?? entry.reason}×${entry.count}`)
    .join('；')

  /** 统一的命中日志：只有计数、规则 id、工具名。 */
  const logHits = (toolName, report, extra) => {
    ctx.logger.info(
      `content-policy: ${toolName} 命中 ${describeHits(report.hits)}（共 ${report.totalHits} 处，扫描 ${report.scannedBytes} 字节）${extra ?? ''}`,
    )
  }

  /** strip 的命中日志：同样只有计数、规则 id、工具名。 */
  const logStrip = (toolName, report, extra) => {
    ctx.logger.info(
      `content-policy: ${toolName} 结构最小化 ${describeHits(report.hits)}（丢弃 ${report.dropped} 个字段/元素，截断 ${report.truncatedFields} 个字段，保留原样 ${report.kept}，目标不存在 ${report.missing}，保留字节 ${report.scannedBytes}）${extra ?? ''}`,
    )
  }

  // ── 接缝 1：tools/execute（主接缝） ──────────────────────────────────────
  // 刻意**不**使用 { prepend: true }：后注册者在瀑布里位于更早注册的 prepend
  // 监听器（例如 dsh-spill-policy）之内，于是 spill 拿到的已经是改写后的结果，
  // 连落盘的超长结果预览里也不会留下命中文本。改写发生在最早的位置：注册表
  // 拿到我们的返回值后会用 value 重新渲染 content 与 meta。
  //
  // 两条策略共用这一条监听器：**先 strip（结构最小化），后正则（内容改写）**。
  if (replaceRules.length > 0 || stripRules.length > 0) {
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      const applicable = {
        strip: stripsFor(exec.name),
        rules: rulesFor(exec.name, replaceRules),
      }
      if (applicable.strip.length === 0 && applicable.rules.length === 0) return result
      const budget = createBudget(maxScannedBytes)
      try {
        // 失败结果没有 value 可替换（dsh-tools/lib/index.js:3392、:3449-3455），
        // strip 对它不生效；它仍由正则规则处理 content / error.message。
        if (result.isError) return scrubFailure(exec, result, applicable.rules, budget)
        return scrubSuccess(exec, result, applicable, budget)
      } catch (error) {
        // 策略自身出错绝不能把一次成功的工具调用变成失败：保留原结果并告警。
        ctx.logger.warn(`content-policy: ${exec.name} 清洗失败，已保留原结果：${errorText(error)}`)
        return result
      }
    })
  }

  /**
   * 成功结果：改写 value，让注册表重新派生 content + meta。
   *
   * 顺序固定为 **strip → 正则**（理由见模块头注释）：strip 是最可靠、最省的一步，
   * 先跑能保证"该丢的载荷"不会因为正则扫描把预算吃光而活下来，也省下对即将被丢弃
   * 文本的扫描。两条策略共用同一个预算对象，因此 `onBudgetExceeded` 对两者统一生效。
   */
  function scrubSuccess(exec, result, applicable, budget) {
    const tool = lookupTool(ctx, exec)
    const schema = tool?.output?.schema

    const stripReport = applicable.strip.length === 0
      ? undefined
      : stripValue(result.value, { rules: applicable.strip, schema, budget })
    if (stripReport !== undefined) {
      const blocked = stripViolation(stripReport)
      if (blocked !== undefined) {
        ctx.logger.warn(`content-policy: ${exec.name} 结果无法安全最小化（${blocked}），已降级为终态错误`)
        return policyFailure(`content-policy: ${exec.name} 的结果未通过内容策略（${blocked}），为避免不可控内容落盘，本次结果已被丢弃。`)
      }
      if (stripReport.refused > 0) {
        ctx.logger.warn(`content-policy: ${exec.name} 有 ${stripReport.refused} 处结构最小化规则无法应用（${describeRefusals(stripReport.refusals)}），已按 onStripRefused=skip 保留原字段：${refusalDetail(stripReport)}`)
      }
    }
    const stripped = stripReport === undefined ? result.value : stripReport.value

    const report = applicable.rules.length === 0
      ? undefined
      : scrubValue(stripped, { rules: applicable.rules, schema, budget })
    if (report !== undefined) {
      const blocked = violation(report)
      if (blocked !== undefined) {
        ctx.logger.warn(`content-policy: ${exec.name} 结果无法安全改写（${blocked}），已降级为终态错误`)
        return policyFailure(`content-policy: ${exec.name} 的结果未通过内容策略（${blocked}），为避免不可控内容落盘，本次结果已被丢弃。`)
      }
    }
    const value = report === undefined ? stripped : report.value

    // 同一性快路径：两条策略都没有改动任何东西时按引用返回，注册表走
    // `canonicalResults.get(result) === exec.token`（dsh-tools/lib/index.js:3448），
    // 不会二次渲染，也不会重建 meta。
    if (value === result.value) {
      if (stripReport !== undefined && stripReport.truncated) reportTruncation(exec, stripReport)
      if (report !== undefined && report.truncated) reportTruncation(exec, report)
      return result
    }
    if (stripReport !== undefined && stripReport.changed) {
      logStrip(exec.name, stripReport, onBudgetExceeded === 'partial' && stripReport.truncated ? '（预算用尽，后续字段未处理）' : '')
    }
    if (report !== undefined && report.changed) {
      logHits(exec.name, report, report.truncated ? '（预算用尽，后续未扫描）' : '')
    }
    if (stripReport !== undefined && stripReport.truncated) reportTruncation(exec, stripReport)
    if (report !== undefined && report.truncated) reportTruncation(exec, report)
    const contexts = result.additionalContexts === undefined ? [] : [...result.additionalContexts]
    if (notify) contexts.push(notice(noticeText(exec, stripReport, report)))
    return {
      isError: false,
      value,
      ...contexts.length > 0 ? { additionalContexts: contexts } : {},
    }
  }

  /**
   * 失败结果：`normalizeDispatchResult` 对失败结果逐字复制
   * content 与 meta（dsh-tools/lib/index.js:3449-3455），且失败结果不能替换 value
   * （:3392）。所以这里自己构造 `{ isError: true, error, content }`，
   * 并且**只要重建就一定不带 `meta`** —— meta 没有 schema、也无法从 value 重新派生，
   * 无法确认它是否镜像了命中文本，因此不留存。
   */
  function scrubFailure(exec, result, applicable, budget) {
    const contentReport = scrubContentBlocks(result.content, { rules: applicable, budget })
    const originalMessage = typeof result.error?.message === 'string' ? result.error.message : undefined
    const messageReport = originalMessage === undefined
      ? undefined
      : scrubValue(originalMessage, { rules: applicable, budget })
    const blocked = violation(contentReport)
      ?? (messageReport === undefined ? undefined : violation(messageReport))
    if (blocked !== undefined) {
      ctx.logger.warn(`content-policy: ${exec.name} 失败结果无法安全改写（${blocked}），已降级为终态错误`)
      return policyFailure(`content-policy: ${exec.name} 的失败结果未通过内容策略（${blocked}），为避免不可控内容落盘已被丢弃。`)
    }
    const contentChanged = contentReport.value !== result.content
    const messageChanged = messageReport !== undefined && messageReport.value !== originalMessage
    const touched = contentChanged || messageChanged
    if (!touched && result.meta === undefined) {
      if (contentReport.truncated) reportTruncation(exec, contentReport)
      return result
    }
    if (contentChanged) logHits(exec.name, contentReport, '（失败结果）')
    if (result.meta !== undefined) {
      ctx.logger.warn(`content-policy: ${exec.name} 的失败结果带有 meta，已按策略丢弃（无法确认其是否镜像了命中文本）`)
    }
    const report = contentChanged ? contentReport : messageReport
    const contexts = result.additionalContexts === undefined ? [] : [...result.additionalContexts]
    if (notify && touched && report !== undefined) contexts.push(notice(noticeText(exec, undefined, report)))
    return {
      isError: true,
      error: {
        ...result.error,
        ...messageChanged ? { message: messageReport.value } : {},
      },
      content: contentChanged ? contentReport.value : result.content,
      ...contexts.length > 0 ? { additionalContexts: contexts } : {},
    }
  }

  /** 预算截断告警（不改结果，只记录）。 */
  function reportTruncation(exec, report) {
    ctx.logger.warn(
      `content-policy: ${exec.name} 扫描预算 ${maxScannedBytes} 字节用尽，剩余内容未扫描（跳过 ${report.skipped} 个叶子/字段）`,
    )
  }

  /** 通知文本本体（只含规则 id 与计数，不含任何被处理的内容）。 */
  function noticeText(exec, stripReport, report) {
    const parts = []
    if (stripReport !== undefined && stripReport.changed) {
      parts.push(`[内容策略] 工具 ${exec.name} 的结果已做结构最小化 ${describeHits(stripReport.hits)}：丢弃 ${stripReport.dropped} 个字段/元素、截断 ${stripReport.truncatedFields} 个字段（被丢弃的字段不再出现在结果里）。`)
    }
    if (report !== undefined && report.changed) {
      parts.push(`[内容策略] 工具 ${exec.name} 的结果命中规则 ${describeHits(report.hits)}，命中片段已按规则改写。`)
    }
    if (report !== undefined && report.pinned > 0) parts.push(`另有 ${report.pinned} 处因输出 schema 的 enum/const 固定而保持原样。`)
    if (stripReport !== undefined && stripReport.refused > 0) {
      parts.push(`另有 ${stripReport.refused} 处结构最小化规则无法应用（${describeRefusals(stripReport.refusals)}），对应字段已保留。`)
    }
    if (stripReport !== undefined && stripReport.truncated) parts.push(`扫描预算（${maxScannedBytes} 字节）已用尽，其余字段未最小化。`)
    if (report !== undefined && report.truncated) parts.push(`扫描预算（${maxScannedBytes} 字节）已用尽，其余内容未扫描。`)
    if (report !== undefined && report.unsafe > 0) parts.push(`另有 ${report.unsafe} 个节点无法安全遍历，保持原样。`)
    if (stripReport !== undefined && stripReport.unsafe > 0) parts.push(`另有 ${stripReport.unsafe} 个节点无法安全遍历，保持原样。`)
    return parts.join('')
  }

  // ── 接缝 2：tools/pre-execute（阻断；参数不可改写） ──────────────────────
  if (blockRules.length > 0) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const applicable = rulesFor(exec.name, blockRules)
      if (applicable.length === 0) return next()
      const report = detectValue(exec.arguments, { rules: applicable, budget: createBudget(maxScannedBytes) })
      if (!report.matched) return next()
      ctx.logger.warn(`content-policy: ${exec.name} 的参数命中阻断规则 ${describeHits(report.hits)}，本次调用被拒绝`)
      return {
        kind: 'deny',
        reason: `content-policy: 工具 ${exec.name} 的调用参数命中阻断规则 ${describeHits(report.hits)}，已拒绝执行（命中文本不会出现在本提示里）。注意：工具参数在派发前已经写入会话日志，阻断只能阻止工具执行与结果产生。`,
      }
    })
  }

  // ── 接缝 3：tools/ptc-dispatch-log（run_code 子调用的持久化副本兜底） ────
  // 这条接缝只拿得到 content 块（dsh-tools/lib/index.js:1235-1242），没有 value，
  // 所以 strip 在这里无从下手：结构最小化只作用于成功结果的 value。
  if (replaceRules.length > 0) {
    ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
      const content = await next()
      const applicable = rulesFor(dispatch.name, replaceRules)
      if (applicable.length === 0) return content
      const report = scrubContentBlocks(content, { rules: applicable, budget: createBudget(maxScannedBytes) })
      if (report.value === content) return content
      ctx.logger.info(
        `content-policy: ${dispatch.name} 的 ptc 派发日志副本命中 ${describeHits(report.hits)}（只改日志副本，程序已拿到的值不受影响）`,
      )
      return report.value
    })
  }
}

/** 解析并校验 `maxScannedBytes`。 */
function resolveMaxScannedBytes(value) {
  if (value === undefined) return DEFAULT_MAX_SCANNED_BYTES
  if (value === Infinity) return Infinity
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`content-policy: maxScannedBytes 必须是正整数或 Infinity（得到 ${String(value)}）`)
  }
  return value
}

/** 通过注册表解析调用者可见的工具定义（失败一律当作"没有 schema"）。 */
function lookupTool(ctx, exec) {
  try {
    return ctx.tools.get(exec.name, exec.agent)
  } catch {
    return undefined
  }
}

/** 错误文本（绝不包含被处理的工具内容）。 */
function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  return typeof error.message === 'string' ? error.message : String(error)
}
